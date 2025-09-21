// api/admin/update.js
import { kv } from "@vercel/kv";

const ALLOWED_ORIGIN =
  process.env.ALLOWED_ORIGIN || process.env.DASHBOARD_BASE_URL || "";

export default async function handler(req, res) {
  if (ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-admin-secret");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") return res.status(405).end();

  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  const headerSecret = req.headers["x-admin-secret"];
  if (!ADMIN_SECRET || headerSecret !== ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { email, payload } = req.body ?? {};
  if (!email || !payload || typeof payload !== "object") {
    return res.status(400).json({ error: "Missing email or payload (object)" });
  }

  try {
    const normalized = String(email).trim().toLowerCase();
    const key = `qr:email:${normalized}`;

    // read current record (if any) to get old partner
    const old = await kv.hgetall(key);
    let oldPartner = null;
    if (old && old.payload) {
      try {
        oldPartner = JSON.parse(old.payload).partner?.toLowerCase() || null;
      } catch {}
    }

    // write new record (preserve used flag or createdAt if present)
    await kv.hset(key, {
      email: normalized,
      used: old && old.used ? old.used : "false",
      payload: JSON.stringify(payload),
      createdAt:
        old && old.createdAt ? old.createdAt : new Date().toISOString(),
    });

    // update partner indices
    if (payload.partner) {
      const newPartner = String(payload.partner).toLowerCase();
      await kv.sadd(`partner:${newPartner}`, normalized);
      await kv.sadd("partners", newPartner);

      if (oldPartner && oldPartner !== newPartner) {
        await kv.srem(`partner:${oldPartner}`, normalized);
      }
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("admin update error:", e);
    return res.status(500).json({ error: "server error" });
  }
}
