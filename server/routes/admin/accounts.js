import { kv } from "@vercel/kv";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";

const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const ALLOWED_ORIGIN =
  process.env.ALLOWED_ORIGIN || process.env.DASHBOARD_BASE_URL || "";
const JWT_SECRET = process.env.JWT_SECRET || "";

const upsertSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8, "Password must be at least 8 characters"),
    partnerId: z.string().min(1, "partnerId is required").optional(),
    role: z.enum(["partner", "admin"]).default("partner"),
    name: z.string().min(1).max(120).optional(),
  })
  .refine(
    (payload) => payload.role === "admin" || Boolean(payload.partnerId),
    {
      message: "partnerId is required for partner accounts",
      path: ["partnerId"],
    }
  );

function setCors(res) {
  if (ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST,PUT,OPTIONS");
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

async function handleUpsert(body) {
  const payload = upsertSchema.parse(body ?? {});
  const email = payload.email.toLowerCase();
  const passwordHash = await bcrypt.hash(payload.password, 12);
  const partnerId = payload.partnerId?.trim() || "";

  await kv.hset(`partnerUser:${email}`, {
    email,
    passwordHash,
    partnerId,
    role: payload.role,
    name: payload.name || "",
    updatedAt: new Date().toISOString(),
  });

  await kv.sadd("partnerUsers", email);

  return {
    success: true,
    email,
    partnerId,
    role: payload.role,
  };
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (!["POST", "PUT"].includes(req.method)) {
    return respond(res, 405, { error: "Method Not Allowed" });
  }

  if (!authorize(req)) {
    return respond(res, 401, { error: "Unauthorized" });
  }

  try {
    const data = await handleUpsert(req.body);
    return respond(res, 200, data);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return respond(res, 400, {
        error: "ValidationError",
        issues: err.flatten(),
      });
    }

    console.error("admin accounts error", err);
    return respond(res, 500, { error: "Internal server error" });
  }
}
