// /api/tilda-proxy.js
// POST endpoint to accept Tilda submissions, save them server-side (via /api/register),
// then forward the payload (with register response) to your Zapier catch hook.

const ZAPIER_HOOK = process.env.ZAPIER_CATCH_HOOK || ""; // Zapier catch hook
const BASE_URL = process.env.BASE_URL || "https://zabava-server.vercel.app"; // your server base

function parseBodyString(str) {
  if (!str) return {};
  // try JSON
  try {
    return JSON.parse(str);
  } catch {}
  // try urlencoded
  try {
    const out = {};
    for (const [k, v] of new URLSearchParams(str)) out[k] = v;
    return out;
  } catch {}
  return { raw: String(str) };
}

async function readRaw(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// helper to find likely email property
function findEmail(obj) {
  if (!obj || typeof obj !== "object") return "";
  const candidates = [
    "email",
    "Email",
    "e-mail",
    "email_address",
    "emailAddress",
  ];
  for (const c of candidates) {
    if (obj[c]) return String(obj[c]).trim().toLowerCase();
  }
  // fallback: search values for something that looks like an email
  for (const k of Object.keys(obj)) {
    const v = String(obj[k] || "");
    if (/@.+\..+/.test(v)) return v.trim().toLowerCase();
  }
  return "";
}

export default async function handler(req, res) {
  // allow CORS from any origin (adjust in production to your domain)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // quick validation for GET (Tilda can make GET to verify)
  if (req.method === "GET") return res.status(200).send("ok");

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).send("Method Not Allowed");
  }

  // Read payload (Tilda may send JSON or form-encoded)
  let payload = {};
  if (
    req.body &&
    typeof req.body === "object" &&
    Object.keys(req.body).length
  ) {
    payload = req.body;
  } else {
    const raw = await readRaw(req);
    payload = parseBodyString(raw);
  }

  // Normalize email
  const email = findEmail(payload) || "";

  // Remove common Tilda internal fields if present (optional)
  if (payload && typeof payload === "object") {
    delete payload.formid;
    delete payload.formname;
    delete payload.tranid;
  }

  // 1) Call your register endpoint so the record is saved into KV
  let registerResult = null;
  try {
    const registerUrl = BASE_URL.replace(/\/$/, "") + "/api/register";
    const registerBody = {
      email: email || undefined,
      data: payload,
      ttlSeconds: 7 * 24 * 3600, // optional default TTL (7 days) — change if needed
    };
    const r = await fetch(registerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registerBody),
    });
    // attempt to parse JSON; may be text on error
    try {
      registerResult = await r.json();
    } catch {
      registerResult = {
        status: r.status,
        text: await r.text().catch(() => ""),
      };
    }
  } catch (err) {
    registerResult = { error: String(err) };
  }

  // Attach register response so Zapier receives it and can use verifyUrl immediately
  const forwardPayload = {
    ...payload,
    _register: registerResult,
  };

  // 2) Forward to Zapier (best-effort). Do not block Tilda on Zapier failure.
  let forwarded = false;
  if (ZAPIER_HOOK) {
    try {
      // fire-and-wait: we wait so Zapier has context right away (but this is still fast)
      const r2 = await fetch(ZAPIER_HOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(forwardPayload),
      });
      forwarded = r2.ok;
    } catch (e) {
      // swallow errors; we'll still return success to Tilda
      forwarded = false;
      console.warn("tilda-proxy -> zapier forward failed:", String(e));
    }
  }

  // 3) Respond to Tilda quickly (200). Also include register/zapier result for debugging.
  return res.status(200).json({
    ok: true,
    registered: !!(registerResult && !registerResult.error),
    registerResult,
    forwardedToZapier: forwarded,
  });
}
