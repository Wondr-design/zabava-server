import jwt from "jsonwebtoken";
import { z } from "zod";
import { kv } from "@vercel/kv";
import { parsePayload } from "../../../lib/partner-data.js";

const ZAPIER_VISIT_HOOK = process.env.ZAPIER_VISIT_HOOK || "";

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const JWT_SECRET = process.env.JWT_SECRET;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

const requestSchema = z.object({
  email: z.string().email(),
  partnerId: z.string().min(1),
});

const tokenSchema = z.object({
  authorization: z
    .string()
    .startsWith("Bearer ", "Missing bearer token")
    .transform((value) => value.slice(7).trim()),
});

function validateAccess(tokenPayload, requestedPartnerId) {
  if (!tokenPayload) return false;
  if (tokenPayload.role !== "partner") {
    return false;
  }
  const partnerId = (tokenPayload.partnerId || "").toLowerCase();
  return partnerId && partnerId === String(requestedPartnerId).toLowerCase();
}

function respond(res, status, payload) {
  return res.status(status).json(payload);
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return respond(res, 405, { error: "Method Not Allowed" });
  }

  if (!JWT_SECRET) {
    console.error("JWT_SECRET is not configured");
    return respond(res, 500, { error: "Server configuration error" });
  }

  try {
    const { authorization } = tokenSchema.parse(req.headers ?? {});
    let tokenPayload;
    try {
      tokenPayload = jwt.verify(authorization, JWT_SECRET);
    } catch {
      return respond(res, 401, { error: "Invalid token" });
    }

    const body = requestSchema.parse(req.body ?? {});
    const partnerId = body.partnerId.toLowerCase();

    if (!validateAccess(tokenPayload, partnerId)) {
      return respond(res, 403, { error: "Forbidden" });
    }

    const email = body.email.trim().toLowerCase();
    const key = `qr:email:${email}`;
    const record = await kv.hgetall(key);
    if (!record) {
      return respond(res, 404, { error: "Submission not found" });
    }

    const isMember = await kv.sismember(`partner:${partnerId}`, email);
    if (!isMember) {
      return respond(res, 403, { error: "Submission does not belong to this partner" });
    }

    const parsedPayload = parsePayload(record);

    if (String(record.visited || "").toLowerCase() === "true") {
      return respond(res, 200, {
        email,
        partnerId,
        visited: true,
        visitedAt: record.visitedAt || record.scannedAt || record.createdAt || null,
        submission: parsedPayload,
      });
    }

    const visitedAt = new Date().toISOString();

    await kv.hset(key, {
      visited: "true",
      visitedAt,
    });

    if (ZAPIER_VISIT_HOOK) {
      const attraction =
        parsedPayload.attractionName ||
        parsedPayload.partnerName ||
        parsedPayload.partnerLabel ||
        record.partnerId ||
        partnerId;

      const hookBody = {
        email,
        partnerId,
        visitedAt,
        attraction,
        submission: {
          ...parsedPayload,
          partnerId: record.partnerId || partnerId,
        },
      };

      fetch(ZAPIER_VISIT_HOOK, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(hookBody),
      }).catch((err) => console.warn("visit webhook failed", err));
    }

    return respond(res, 200, {
      email,
      partnerId,
      visited: true,
      visitedAt,
      submission: parsedPayload,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return respond(res, 400, { error: "ValidationError", details: err.flatten() });
    }
    console.error("partner visit update error", err);
    return respond(res, 500, { error: "Internal server error" });
  }
}
