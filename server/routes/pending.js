// /api/pending.js
import { kv } from "@vercel/kv";

const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const PENDING_ACCESS_TOKEN = process.env.PENDING_ACCESS_TOKEN || "";
const PENDING_ALLOWED_ORIGIN =
  process.env.PENDING_ALLOWED_ORIGIN ||
  process.env.ALLOWED_ORIGIN ||
  process.env.DASHBOARD_BASE_URL ||
  "";

function isAuthorized(req) {
  const pendingToken = req.headers["x-pending-token"];
  if (PENDING_ACCESS_TOKEN && pendingToken === PENDING_ACCESS_TOKEN) {
    return true;
  }

  const adminToken = req.headers["x-admin-secret"];
  if (ADMIN_SECRET && adminToken === ADMIN_SECRET) {
    return true;
  }

  return false;
}

// Support POST to set pending record by RID or email, and GET by rid or email.
export default async function handler(req, res) {
  // allow CORS for Tilda demo; restrict in production
  if (PENDING_ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", PENDING_ALLOWED_ORIGIN);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, x-pending-token, x-admin-secret"
  );
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    if (req.method === "GET") {
      const rid = (req.query.rid || "").trim();
      const email = (req.query.email || "").trim().toLowerCase();

      if (rid) {
        const data = await kv.hgetall(`pending:${rid}`);
        if (!data || !data.verifyUrl)
          return res.status(404).json({ error: "not found" });
        return res.status(200).json(data);
      }

      if (email) {
        const data = await kv.hgetall(`pending:email:${email}`);
        if (!data || !data.verifyUrl)
          return res.status(404).json({ error: "not found" });
        return res.status(200).json(data);
      }

      return res.status(400).json({ error: "Provide ?rid=... or ?email=..." });
    }

    if (req.method === "POST") {
      const { rid, email, verifyUrl, qrUrl, key } = req.body || {};
      if (!verifyUrl && !qrUrl)
        return res.status(400).json({ error: "missing verifyUrl or qrUrl" });

      const ttl = 60 * 60; // keep pending for 1 hour
      if (rid) {
        await kv.hset(`pending:${String(rid)}`, {
          verifyUrl,
          qrUrl: qrUrl || "",
          key: key || "",
        });
        await kv.expire(`pending:${String(rid)}`, ttl);
      }

      if (email) {
        const n = String(email).trim().toLowerCase();
        await kv.hset(`pending:email:${n}`, {
          verifyUrl,
          qrUrl: qrUrl || "",
          key: key || "",
        });
        await kv.expire(`pending:email:${n}`, ttl);
      }

      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, OPTIONS");
    res.status(405).end();
  } catch (e) {
    console.error("pending error", e);
    res.status(500).json({ error: "server error" });
  }
}
