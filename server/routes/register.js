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

    const { email, redemptionCode, ...rest } = req.body || {};

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

    // Handle redemption code if provided
    let redemptionInfo = null;
    if (redemptionCode) {
      const redemptionKey = `redemption:${redemptionCode}`;
      const redemptionData = await kv.hgetall(redemptionKey);
      
      if (redemptionData && redemptionData.email === normalizedEmail) {
        // Check if redemption is still valid
        const expiresAt = new Date(redemptionData.expiresAt);
        const now = new Date();
        
        if (expiresAt > now && redemptionData.status === "pending") {
          // Attach redemption to this booking
          record.redemptionCode = redemptionCode;
          record.hasRedemption = "true";
          record.redemptionReward = redemptionData.rewardName;
          record.redemptionValue = redemptionData.pointsSpent;
          
          // Update redemption status
          await kv.hset(redemptionKey, "status", "applied");
          await kv.hset(redemptionKey, "appliedToBooking", key);
          await kv.hset(redemptionKey, "appliedAt", createdAtIso);
          await kv.hset(redemptionKey, "partnerId", rest.partner_id || rest.partnerId || "");
          
          redemptionInfo = {
            code: redemptionCode,
            reward: redemptionData.rewardName,
            value: redemptionData.pointsSpent,
            status: "Applied to booking"
          };
        } else if (redemptionData.status === "used") {
          return res.status(400).json({ 
            error: "Redemption code has already been used",
            code: redemptionCode 
          });
        } else if (expiresAt <= now) {
          return res.status(400).json({ 
            error: "Redemption code has expired",
            code: redemptionCode,
            expiredAt: expiresAt.toISOString()
          });
        }
      } else if (redemptionData && redemptionData.email !== normalizedEmail) {
        return res.status(400).json({ 
          error: "This redemption code belongs to a different user",
          code: redemptionCode 
        });
      } else {
        return res.status(400).json({ 
          error: "Invalid redemption code",
          code: redemptionCode 
        });
      }
    }

    // If user provided a redemption code, validate and attach it
    if (redemptionCode) {
      const redemptionKey = `redemption:${redemptionCode}`;
      const redemptionData = await kv.hgetall(redemptionKey);
      
      if (redemptionData && redemptionData.email === normalizedEmail) {
        // Check if redemption is still valid
        const expiresAt = new Date(redemptionData.expiresAt);
        if (expiresAt > new Date() && redemptionData.status === "pending") {
          record.redemptionCode = redemptionCode;
          record.redemptionDetails = JSON.stringify({
            rewardName: redemptionData.rewardName,
            pointsValue: redemptionData.pointsSpent,
            redeemedAt: redemptionData.redeemedAt
          });
          
          // Update redemption status to "approved" (being used)
          await kv.hset(redemptionKey, "status", "approved");
          await kv.hset(redemptionKey, "usedInBooking", key);
          await kv.hset(redemptionKey, "usedAt", createdAtIso);
        }
      }
    }

    let partnerKey = extractPartnerId(rest);

    if (partnerKey) {
      const normalizedPartnerKey = String(partnerKey).trim().toLowerCase();

      await safeSAdd(`partner:${normalizedPartnerKey}`, normalizedEmail);
      await safeSAdd("partners", normalizedPartnerKey);
      record.partnerId = normalizedPartnerKey;
    }

    await kv.hset(key, record);

    const baseUrl = process.env.BASE_URL || "https://zabava-server.vercel.app";

    const response = {
      success: true,
      email: normalizedEmail,
      verifyUrl: `${baseUrl}/api/verify?email=${encodeURIComponent(
        normalizedEmail
      )}`,
      key,
      message: "Registration successful",
    };

    // Include redemption info if a redemption was applied
    if (redemptionInfo) {
      response.redemption = redemptionInfo;
      response.message = "Registration successful with reward redemption applied";
    }

    return res.status(200).json(response);
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
