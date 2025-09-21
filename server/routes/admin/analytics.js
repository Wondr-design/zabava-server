import jwt from "jsonwebtoken";
import { z } from "zod";
import { kv } from "@vercel/kv";
import { loadPartnerData, EMPTY_METRICS } from "../../../lib/partner-data.js";

const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const ALLOWED_ORIGIN =
  process.env.ALLOWED_ORIGIN || process.env.DASHBOARD_BASE_URL || "";
const JWT_SECRET = process.env.JWT_SECRET || "";

const querySchema = z.object({
  mode: z.enum(["metrics", "submissions", "export"]).default("metrics"),
  partnerId: z.string().optional(),
  search: z.string().optional(),
  limit: z
    .preprocess((value) => (value ? Number(value) : undefined), z.number().int().positive().max(500))
    .optional(),
});

function setCors(res) {
  if (ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-admin-secret"
  );
}

function respond(res, status, payload) {
  return res.status(status).json(payload);
}

function authorize(req) {
  if (ADMIN_SECRET && req.headers["x-admin-secret"] === ADMIN_SECRET) {
    return true;
  }

  if (!JWT_SECRET) {
    return false;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || typeof authHeader !== "string") {
    return false;
  }
  if (!authHeader.startsWith("Bearer ")) {
    return false;
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return false;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return payload && payload.role === "admin";
  } catch (err) {
    return false;
  }
}

async function getPartnerIds(requestedPartnerId) {
  if (requestedPartnerId) {
    return [requestedPartnerId];
  }
  const ids = await kv.smembers("partners");
  return ids.filter(Boolean);
}

function aggregateMetrics(datasets) {
  const totals = { ...EMPTY_METRICS };
  const revenueTrendMap = new Map();
  const latest = [];
  const partners = [];

  datasets.forEach(({ partnerId, submissions, metrics }) => {
    totals.count += metrics.count;
    totals.used += metrics.used;
    totals.unused += metrics.unused;
    totals.visited = (totals.visited || 0) + (metrics.visited || 0);
    totals.notVisited = (totals.notVisited || 0) + (metrics.notVisited || 0);
    totals.revenue += metrics.revenue;
    totals.points += metrics.points;
    totals.bonusRedemptions += metrics.bonusRedemptions;

    partners.push({
      id: partnerId,
      metrics,
      lastSubmissionAt: submissions[0]?.createdAt || null,
    });

    submissions.forEach((submission) => {
      const dateKey = submission.createdAt
        ? new Date(submission.createdAt).toISOString().slice(0, 10)
        : null;
      if (dateKey) {
        revenueTrendMap.set(
          dateKey,
          (revenueTrendMap.get(dateKey) || 0) + Number(submission.totalPrice || 0)
        );
      }
      latest.push({
        partnerId,
        ...submission,
      });
    });
  });

  if (totals.count) {
    totals.averageRevenue = Math.round(totals.revenue / totals.count);
    totals.averagePoints = Math.round(totals.points / totals.count);
  }

  const revenueTrend = Array.from(revenueTrendMap.entries())
    .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
    .map(([iso, value]) => ({
      date: new Date(iso).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      }),
      value,
    }));

  latest.sort((a, b) => {
    const aTime = new Date(a.createdAt || 0).getTime();
    const bTime = new Date(b.createdAt || 0).getTime();
    return bTime - aTime;
  });

  return {
    totals,
    revenueTrend,
    latestSubmissions: latest,
    partners,
  };
}

function filterSubmissions(submissions, searchTerm) {
  if (!searchTerm) return submissions;
  const term = searchTerm.trim().toLowerCase();
  if (!term) return submissions;
  return submissions.filter((submission) => {
    const haystack = [
      submission.email,
      submission.ticket,
      submission.Categories,
      submission.partnerId,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(term);
  });
}

function buildCsv(rows) {
  const header = [
    "partnerId",
    "email",
    "used",
    "visited",
    "totalPrice",
    "estimatedPoints",
    "ticket",
    "numPeople",
    "createdAt",
    "scannedAt",
    "visitedAt",
    "payload",
  ];

  const lines = [header.join(",")];

  rows.forEach((row) => {
    const payloadCopy = { ...row };
    delete payloadCopy.partnerId;
    delete payloadCopy.email;
    delete payloadCopy.used;
    delete payloadCopy.visited;
    delete payloadCopy.totalPrice;
    delete payloadCopy.estimatedPoints;
    delete payloadCopy.ticket;
    delete payloadCopy.numPeople;
    delete payloadCopy.createdAt;
    delete payloadCopy.scannedAt;
    delete payloadCopy.visitedAt;
    const originalPayload = row.originalPayload || payloadCopy;
    delete payloadCopy.originalPayload;

    const payloadJson = JSON.stringify(originalPayload);

    const values = [
      row.partnerId,
      row.email,
      row.used ? "true" : "false",
      row.visited ? "true" : "false",
      row.totalPrice || 0,
      row.estimatedPoints || 0,
      row.ticket || "",
      row.numPeople || "",
      row.createdAt || "",
      row.scannedAt || "",
      row.visitedAt || "",
      payloadJson ? payloadJson.replace(/"/g, '""') : "",
    ].map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`);

    lines.push(values.join(","));
  });

  return lines.join("\n");
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return respond(res, 405, { error: "Method Not Allowed" });
  }

  if (!authorize(req)) {
    return respond(res, 401, { error: "Unauthorized" });
  }

  try {
    const query = querySchema.parse(req.query ?? {});
    const partnerIds = await getPartnerIds(query.partnerId);

    if (query.mode === "metrics") {
      const datasets = await Promise.all(
        partnerIds.map((id) => loadPartnerData(id))
      );

      const aggregate = aggregateMetrics(datasets);
      const trendLimit = 30;
      const latestLimit = 20;

      return respond(res, 200, {
        totals: aggregate.totals,
        revenueTrend: aggregate.revenueTrend.slice(-trendLimit),
        latestSubmissions: aggregate.latestSubmissions.slice(0, latestLimit),
        partners: aggregate.partners,
        generatedAt: new Date().toISOString(),
      });
    }

    if (query.mode === "submissions") {
      const limit = query.limit ?? 50;
      const searchTerm = query.search || "";
      const datasets = await Promise.all(
        partnerIds.map((id) => loadPartnerData(id))
      );
      const allSubmissions = datasets.flatMap(({ partnerId, submissions }) =>
        submissions.map((submission) => ({ partnerId, ...submission }))
      );
      const filtered = filterSubmissions(allSubmissions, searchTerm);
      return respond(res, 200, {
        items: filtered.slice(0, limit),
        total: filtered.length,
      });
    }

    if (query.mode === "export") {
      const datasets = await Promise.all(
        partnerIds.map((id) => loadPartnerData(id))
      );
      const allSubmissions = datasets.flatMap(({ partnerId, submissions }) =>
        submissions.map((submission) => ({ partnerId, ...submission }))
      );
      const filtered = filterSubmissions(allSubmissions, query.search || "");
      const csv = buildCsv(filtered);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="submissions-${Date.now()}.csv"`
      );
      return res.status(200).send(csv);
    }

    return respond(res, 400, { error: "Unsupported mode" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return respond(res, 400, {
        error: "ValidationError",
        issues: err.flatten(),
      });
    }

    console.error("admin analytics error", err);
    return respond(res, 500, { error: "Internal server error" });
  }
}
