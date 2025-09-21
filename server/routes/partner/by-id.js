import jwt from "jsonwebtoken";
import { z } from "zod";
import { loadPartnerData } from "../../../lib/partner-data.js";

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const JWT_SECRET = process.env.JWT_SECRET;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

const requestSchema = z.object({
  authorization: z
    .string()
    .startsWith("Bearer ", { message: "Missing bearer token" })
    .transform((value) => value.slice(7).trim()),
});

function respond(res, status, payload) {
  return res.status(status).json(payload);
}

function validateAccess(tokenPayload, requestedPartnerId) {
  if (!tokenPayload) return false;
  const role = tokenPayload.role || "partner";
  if (role === "admin") {
    return true;
  }
  const partnerId = (tokenPayload.partnerId || "").toLowerCase();
  return partnerId && partnerId === String(requestedPartnerId).toLowerCase();
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    if (!JWT_SECRET) {
      console.error("JWT_SECRET is not configured");
      return respond(res, 500, { error: "Server configuration error" });
    }

    const { authorization } = requestSchema.parse(req.headers ?? {});
    let tokenPayload;
    try {
      tokenPayload = jwt.verify(authorization, JWT_SECRET);
    } catch (err) {
      return respond(res, 401, { error: "Invalid token" });
    }

    const { partnerId } = req.query;

    if (!partnerId) {
      return res.status(400).json({ error: "Partner ID is required" });
    }

    if (!validateAccess(tokenPayload, partnerId)) {
      return respond(res, 403, { error: "Forbidden" });
    }

    const { submissions, metrics } = await loadPartnerData(partnerId);

    return res.status(200).json({
      submissions,
      metrics,
      partner: partnerId,
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return respond(res, 401, {
        error: "Invalid request",
        details: err.flatten(),
      });
    }
    console.error("Partner endpoint error", err);
    return res.status(500).json({ error: "Server error" });
  }
}
