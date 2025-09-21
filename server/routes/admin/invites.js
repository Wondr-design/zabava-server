import { kv } from "@vercel/kv";
import { randomBytes } from "crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";

const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const ALLOWED_ORIGIN =
  process.env.ALLOWED_ORIGIN || process.env.DASHBOARD_BASE_URL || "";
const DASHBOARD_BASE_URL = process.env.DASHBOARD_BASE_URL || "";
const JWT_SECRET = process.env.JWT_SECRET || "";

const createSchema = z.object({
  email: z.string().email(),
  partnerId: z.string().min(1, "partnerId is required"),
  role: z.enum(["partner", "admin"]).default("partner"),
  name: z.string().min(1).max(120).optional(),
  expiresInMinutes: z
    .number()
    .int()
    .positive()
    .max(60 * 24 * 30)
    .optional(),
});

const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z
    .preprocess((value) => (value ? Number(value) : undefined), z.number().int().positive().max(200))
    .optional(),
});

function setCors(res) {
  if (ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
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

function buildInviteUrl(token, email) {
  if (!DASHBOARD_BASE_URL) return null;
  const base = DASHBOARD_BASE_URL.replace(/\/$/, "");
  const params = new URLSearchParams({ token });
  if (email) {
    params.set("email", email);
  }
  return `${base}/signup?${params.toString()}`;
}

async function handleCreate(req, res) {
  const payload = createSchema.parse(req.body ?? {});
  const token = randomBytes(24).toString("hex");
  const inviteKey = `partnerInvite:${token}`;

  const now = new Date();
  const createdAtIso = now.toISOString();
  const expiresInMinutes = payload.expiresInMinutes ?? 60 * 24 * 7;
  const expiresAt = new Date(now.getTime() + expiresInMinutes * 60_000);

  await kv.hset(inviteKey, {
    token,
    email: payload.email.toLowerCase(),
    partnerId: payload.partnerId,
    role: payload.role,
    name: payload.name || "",
    createdAt: createdAtIso,
    expiresAt: expiresAt.toISOString(),
    used: "false",
  });

  await kv.expire(inviteKey, expiresInMinutes * 60);
  await kv.sadd("partnerInvites", inviteKey);

  const invite = {
    token,
    partnerId: payload.partnerId,
    role: payload.role,
    email: payload.email,
    name: payload.name || "",
    createdAt: createdAtIso,
    expiresAt: expiresAt.toISOString(),
    used: false,
    usedAt: null,
    inviteUrl: buildInviteUrl(token, payload.email),
  };

  return respond(res, 200, { invite });
}

async function handleList(req, res) {
  const query = listQuerySchema.parse(req.query ?? {});
  const limit = query.limit ?? 50;
  const cursorPrefix = query.cursor ? String(query.cursor) : null;

  const invitesKeys = await kv.smembers("partnerInvites");
  const sortedKeys = invitesKeys
    .filter((key) => key && typeof key === "string")
    .sort((a, b) => b.localeCompare(a));

  const startIndex = cursorPrefix
    ? sortedKeys.findIndex((key) => key === cursorPrefix)
    : 0;

  const pageKeys = sortedKeys.slice(startIndex, startIndex + limit);

  const invites = await Promise.all(
    pageKeys.map(async (key) => {
      const record = await kv.hgetall(key);
      if (!record) return null;

      const token = record.token || key.replace("partnerInvite:", "");
      const email = record.email ? String(record.email).toLowerCase() : null;
      const partnerId = record.partnerId || null;
      const name = record.name || null;
      const createdAt = record.createdAt || null;
      const expiresAt = record.expiresAt || null;

      let used = record.used === "true";
      let usedAt = record.usedAt || null;

      if (!used && email) {
        const existingUser = await kv.hgetall(`partnerUser:${email}`);
        if (existingUser && existingUser.email) {
          used = true;
          usedAt = usedAt || existingUser.createdAt || new Date().toISOString();
          await kv.hset(key, {
            used: "true",
            usedAt,
          }).catch(() => {});
        }
      }

      return {
        token,
        email,
        partnerId,
        role: record.role || "partner",
        name,
        createdAt,
        expiresAt,
        used,
        usedAt,
        inviteUrl: buildInviteUrl(token, record.email || undefined),
      };
    })
  );

  const nextCursor = sortedKeys[startIndex + limit] || null;

  return respond(res, 200, {
    items: invites.filter(Boolean),
    nextCursor,
  });
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (!authorize(req)) {
    return respond(res, 401, { error: "Unauthorized" });
  }

  try {
    if (req.method === "POST") {
      return await handleCreate(req, res);
    }

    if (req.method === "GET") {
      return await handleList(req, res);
    }

    return respond(res, 405, { error: "Method Not Allowed" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return respond(res, 400, {
        error: "ValidationError",
        issues: err.flatten(),
      });
    }

    console.error("admin invites error", err);
    return respond(res, 500, { error: "Internal server error" });
  }
}
