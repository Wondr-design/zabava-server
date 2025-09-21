import jwt from "jsonwebtoken";
import { z } from "zod";
import { kv } from "@vercel/kv";
import {
  buildDefaultPartnerMeta,
  loadPartnerMeta,
  savePartnerMeta,
  listPartnerMetas,
} from "../../../lib/partner-meta.js";

const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const ALLOWED_ORIGIN =
  process.env.ALLOWED_ORIGIN || process.env.DASHBOARD_BASE_URL || "";
const JWT_SECRET = process.env.JWT_SECRET || "";

function setCors(res) {
  if (ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
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

const updateSchema = z.object({
  status: z.enum(["active", "pending", "hidden"]).optional(),
  contract: z
    .object({
      monthlyFee: z.coerce.number().min(0).optional(),
      discountRate: z.coerce.number().min(0).max(100).optional(),
      commissionRate: z.coerce.number().min(0).max(100).optional(),
      commissionBasis: z.enum(["original", "discounted"]).optional(),
    })
    .optional(),
  ticketing: z
    .object({
      ticketTypes: z.array(z.string()).optional(),
      familyRule: z.string().optional(),
    })
    .optional(),
  info: z
    .object({
      contactName: z.string().optional(),
      contactEmail: z.string().optional(),
      payments: z.array(z.string()).optional(),
      facilities: z.array(z.string()).optional(),
      website: z.string().optional(),
    })
    .optional(),
  media: z
    .object({
      logoUrl: z.string().optional(),
      heroImageUrl: z.string().optional(),
    })
    .optional(),
  bonusProgramEnabled: z.boolean().optional(),
  notes: z.string().optional(),
});

function normalize(str) {
  return String(str || "").trim().toLowerCase();
}

async function handleGet(req, res) {
  const searchTerm = normalize(req.query?.search || "");
  const statusFilter = normalize(req.query?.status || "all");
  const partnerId = req.query?.partnerId
    ? normalize(req.query.partnerId)
    : null;

  if (partnerId) {
    const meta = await loadPartnerMeta(partnerId);
    return respond(res, 200, { item: meta });
  }

  const partnerIds = await kv.smembers("partners");
  const items = await listPartnerMetas(partnerIds);

  const filtered = items.filter((item) => {
    if (statusFilter && statusFilter !== "all") {
      if (item.status !== statusFilter) {
        return false;
      }
    }

    if (searchTerm) {
      const haystack = [
        item.partnerId,
        item.info?.contactName,
        item.info?.contactEmail,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(searchTerm)) {
        return false;
      }
    }

    return true;
  });

  return respond(res, 200, { items: filtered });
}

async function handlePut(req, res) {
  const partnerId = req.query?.partnerId
    ? normalize(req.query.partnerId)
    : null;
  if (!partnerId) {
    return respond(res, 400, { error: "partnerId is required" });
  }

  const parsed = updateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return respond(res, 400, {
      error: "ValidationError",
      issues: parsed.error.flatten(),
    });
  }

  const updates = parsed.data;

  // Normalize arrays to remove empty strings
  if (updates.ticketing?.ticketTypes) {
    updates.ticketing.ticketTypes = updates.ticketing.ticketTypes
      .map((value) => value.trim())
      .filter(Boolean);
  }
  if (updates.info?.payments) {
    updates.info.payments = updates.info.payments
      .map((value) => value.trim())
      .filter(Boolean);
  }
  if (updates.info?.facilities) {
    updates.info.facilities = updates.info.facilities
      .map((value) => value.trim())
      .filter(Boolean);
  }

  const saved = await savePartnerMeta(partnerId, updates);
  return respond(res, 200, saved);
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (!authorize(req)) {
    return respond(res, 401, { error: "Unauthorized" });
  }

  if (req.method === "GET") {
    return handleGet(req, res);
  }

  if (req.method === "PUT") {
    return handlePut(req, res);
  }

  return respond(res, 405, { error: "Method Not Allowed" });
}
