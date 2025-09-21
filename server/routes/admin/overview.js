import jwt from "jsonwebtoken";
import { z } from "zod";
import { kv } from "@vercel/kv";
import { parsePayload } from "../../../lib/partner-data.js";
import { loadPartnerMeta } from "../../../lib/partner-meta.js";

const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const ALLOWED_ORIGIN =
  process.env.ALLOWED_ORIGIN || process.env.DASHBOARD_BASE_URL || "";
const JWT_SECRET = process.env.JWT_SECRET || "";

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

function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isSameMonth(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

async function collectOverviewMetrics() {
  const partners = await kv.smembers("partners");
  const today = new Date();
  const totals = {
    activePartners: 0,
    qrsGeneratedToday: 0,
    qrsScannedToday: 0,
    monthlyVisitors: 0,
    totalRevenue: 0,
    totalCommission: 0,
    unvisitedQRCodes: 0,
  };
  let pendingApprovals = 0;

  for (const partnerId of partners) {
    const meta = await loadPartnerMeta(partnerId);
    if (meta.status === "active") {
      totals.activePartners += 1;
    }
    if (meta.status === "pending") {
      pendingApprovals += 1;
    }

    const emails = await kv.smembers(`partner:${partnerId}`);
    if (!emails || emails.length === 0) continue;

    for (const email of emails) {
      const record = await kv.hgetall(`qr:email:${email}`);
      if (!record || !record.email) continue;

      const createdAt = record.createdAt ? new Date(record.createdAt) : null;
      if (createdAt && isSameDay(createdAt, today)) {
        totals.qrsGeneratedToday += 1;
      }

      const parsedPayload = parsePayload(record);
      const visited = String(record.visited || "").toLowerCase() === "true";
      const visitedAt = record.visitedAt ? new Date(record.visitedAt) : null;
      const used = String(record.used || "").toLowerCase() === "true";

      if (used && visitedAt && isSameDay(visitedAt, today)) {
        totals.qrsScannedToday += 1;
      }

      if (visited && visitedAt && isSameMonth(visitedAt, today)) {
        totals.monthlyVisitors += 1;
      }

      if (!visited) {
        totals.unvisitedQRCodes += 1;
      }

      if (visited) {
        const revenue = Number(
          parsedPayload.totalPrice || record.totalPrice || 0
        ) || 0;
        totals.totalRevenue += revenue;
        // commission placeholder – will use admin-configured rules later
      }
    }
  }

  const quickActions = {
    pendingPartnerApprovals: pendingApprovals,
    unusedQRCodes: totals.unvisitedQRCodes,
    insight: totals.qrsGeneratedToday - totals.qrsScannedToday,
  };

  return { totals, quickActions };
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
    const overview = await collectOverviewMetrics();
    return respond(res, 200, overview);
  } catch (err) {
    console.error("admin overview error", err);
    return respond(res, 500, { error: "Internal server error" });
  }
}
