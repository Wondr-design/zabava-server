import { kv } from "@vercel/kv";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "12h";

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  token: z.string().min(10, "Invite token is required"),
  name: z.string().min(1).max(120).optional(),
});

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function respond(res, status, payload) {
  return res.status(status).json(payload);
}

function normalize(str) {
  return String(str || "").trim().toLowerCase();
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  const expires = new Date(expiresAt).getTime();
  if (Number.isNaN(expires)) return false;
  return Date.now() > expires;
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
    const payload = signupSchema.parse(req.body ?? {});
    const email = normalize(payload.email);
    const inviteKey = `partnerInvite:${payload.token}`;
    const invite = await kv.hgetall(inviteKey);

    if (!invite || !invite.token) {
      return respond(res, 400, { error: "Invalid or expired invite" });
    }

    if (invite.used === "true") {
      return respond(res, 400, { error: "Invite already used" });
    }

    if (isExpired(invite.expiresAt)) {
      return respond(res, 400, { error: "Invite has expired" });
    }

    if (invite.email && normalize(invite.email) !== email) {
      return respond(res, 400, {
        error: "Invite email mismatch",
      });
    }

    const userKey = `partnerUser:${email}`;
    const existing = await kv.hgetall(userKey);
    if (existing && existing.email) {
      return respond(res, 409, { error: "Account already exists" });
    }

    const passwordHash = await bcrypt.hash(payload.password, 12);
    const partnerId = invite.partnerId;
    const role = invite.role || "partner";
    const name = payload.name || invite.name || "";

    await kv.hset(userKey, {
      email,
      passwordHash,
      partnerId,
      role,
      name,
      createdAt: new Date().toISOString(),
    });

    await kv.sadd("partnerUsers", email);
    await kv.hset(inviteKey, {
      used: "true",
      usedAt: new Date().toISOString(),
    });

    const token = jwt.sign(
      {
        sub: email,
        partnerId,
        role,
        name: name || undefined,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    return respond(res, 200, {
      token,
      user: {
        email,
        partnerId,
        role,
        name,
      },
      expiresIn: JWT_EXPIRES_IN,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return respond(res, 400, {
        error: "ValidationError",
        issues: err.flatten(),
      });
    }

    console.error("auth/signup error", err);
    return respond(res, 500, { error: "Internal server error" });
  }
}
