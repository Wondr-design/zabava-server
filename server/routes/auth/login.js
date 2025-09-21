import { kv } from "@vercel/kv";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";

const loginSchema = z.object({
  email: z.string().email("Email is required"),
  password: z.string().min(6, "Password is required"),
});

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "12h";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-admin-secret"
  );
}

function respond(res, status, payload) {
  return res.status(status).json(payload);
}

async function getUser(email) {
  const key = `partnerUser:${email}`;
  const record = await kv.hgetall(key);
  if (!record || !record.email) {
    return null;
  }

  return {
    email: String(record.email).toLowerCase(),
    passwordHash: record.passwordHash,
    partnerId: record.partnerId,
    role: record.role || "partner",
    name: record.name || null,
  };
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
    const payload = loginSchema.parse(req.body ?? {});
    const email = payload.email.toLowerCase();
    const user = await getUser(email);

    if (!user || !user.passwordHash) {
      return respond(res, 401, { error: "Invalid credentials" });
    }

    const validPassword = await bcrypt.compare(
      payload.password,
      user.passwordHash
    );

    if (!validPassword) {
      return respond(res, 401, { error: "Invalid credentials" });
    }

    const token = jwt.sign(
      {
        sub: user.email,
        partnerId: user.partnerId,
        role: user.role,
        name: user.name || undefined,
      },
      JWT_SECRET,
      {
        expiresIn: JWT_EXPIRES_IN,
      }
    );

    return respond(res, 200, {
      token,
      user: {
        email: user.email,
        role: user.role,
        partnerId: user.partnerId,
        name: user.name,
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

    console.error("auth/login error", err);
    return respond(res, 500, { error: "Internal server error" });
  }
}
