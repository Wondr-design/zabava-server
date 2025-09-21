import jwt from "jsonwebtoken";
import { z } from "zod";
import { kv } from "@vercel/kv";

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const JWT_SECRET = process.env.JWT_SECRET;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

function respond(res, status, payload) {
  return res.status(status).json(payload);
}

async function loadUser(email) {
  const data = await kv.hgetall(`partnerUser:${email}`);
  if (!data || !data.email) return null;
  return {
    email: String(data.email).toLowerCase(),
    partnerId: data.partnerId,
    role: data.role || "partner",
    name: data.name || null,
  };
}

const tokenSchema = z.object({
  authorization: z
    .string()
    .startsWith("Bearer ", { message: "Missing bearer token" })
    .transform((value) => value.slice(7).trim()),
});

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return respond(res, 405, { error: "Method Not Allowed" });
  }

  if (!JWT_SECRET) {
    console.error("JWT_SECRET is not configured");
    return respond(res, 500, { error: "Server configuration error" });
  }

  try {
    const { authorization } = tokenSchema.parse(req.headers);

    const payload = jwt.verify(authorization, JWT_SECRET);
    const email = String(payload.sub || "").toLowerCase();

    if (!email) {
      return respond(res, 401, { error: "Invalid token" });
    }

    const user = await loadUser(email);
    if (!user) {
      return respond(res, 401, { error: "Invalid token" });
    }

    return respond(res, 200, {
      user,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return respond(res, 401, {
        error: "Invalid token",
        details: err.flatten(),
      });
    }

    console.error("auth/profile error", err);
    return respond(res, 401, { error: "Invalid token" });
  }
}
