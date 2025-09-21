import { kv } from "@vercel/kv";

const ERROR_WEBHOOK_URL = process.env.ERROR_WEBHOOK_URL || "";

const PARTNER_KEY_CANDIDATES = [
  "partner_id",
  "partner",
  "partnerId",
  "partnerID",
  "PartnerID",
];

async function safeSAdd(key, value) {
  try {
    await kv.sadd(key, value);
  } catch (err) {
    if (String(err?.message || "").includes("WRONGTYPE")) {
      await kv.del(key);
      await kv.sadd(key, value);
    } else {
      throw err;
    }
  }
}

function extractPartnerId(source) {
  if (!source) return "";

  const scan = (obj) => {
    if (!obj || typeof obj !== "object") return "";
    for (const key of PARTNER_KEY_CANDIDATES) {
      if (obj[key]) {
        return String(obj[key]);
      }
    }
    return "";
  };

  if (typeof source === "string") {
    try {
      const parsed = JSON.parse(source);
      const value = extractPartnerId(parsed);
      if (value) {
        return value;
      }
    } catch (err) {
      console.warn("Failed to parse partner payload string", err);
    }
    return "";
  }

  const direct = scan(source);
  if (direct) return direct;

  if (source.data) {
    const nested = extractPartnerId(source.data);
    if (nested) {
      return nested;
    }
  }

  return "";
}

async function notifyError(context) {
  if (!ERROR_WEBHOOK_URL) return;
  try {
    const payload = {
      timestamp: new Date().toISOString(),
      source: "api/register",
      ...context,
    };
    await fetch(ERROR_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch (err) {
    console.error("Error webhook failed", err);
  }
}

export default async function registerHandler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    console.log("Simple register request received", {
      method: req.method,
      hasBody: Boolean(req.body && Object.keys(req.body).length),
    });

    const { email, ...rest } = req.body || {};

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    if (!normalizedEmail.includes("@")) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    const key = `qr:email:${normalizedEmail}`;
    const createdAtIso = new Date().toISOString();
    const record = {
      email: normalizedEmail,
      used: "false",
      payload: JSON.stringify(rest),
      createdAt: createdAtIso,
      visited: "false",
      visitedAt: "",
    };

    let partnerKey = extractPartnerId(rest);

    if (partnerKey) {
      const normalizedPartnerKey = String(partnerKey).trim().toLowerCase();

      await safeSAdd(`partner:${normalizedPartnerKey}`, normalizedEmail);
      await safeSAdd("partners", normalizedPartnerKey);
      record.partnerId = normalizedPartnerKey;
    }

    await kv.hset(key, record);

    const baseUrl = process.env.BASE_URL || "https://zabava-server.vercel.app";

    return res.status(200).json({
      success: true,
      email: normalizedEmail,
      verifyUrl: `${baseUrl}/api/verify?email=${encodeURIComponent(
        normalizedEmail
      )}`,
      key,
      message: "Registration successful",
    });
  } catch (error) {
    console.error("Simple register error", {
      message: error.message,
      stack: error.stack,
      hasBody: Boolean(req.body && Object.keys(req.body).length),
    });
    await notifyError({
      error: error.message,
      body: req.body,
    });
    return res.status(500).json({
      error: "Internal server error",
    });
  }
}
