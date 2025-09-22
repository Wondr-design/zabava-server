import { kv } from "@vercel/kv";
import { respond, setCors } from "../../../lib/utils.js";

/**
 * POST /api/bonus/redeem-reward
 * Redeem a reward using user points
 * Body: { email, rewardId }
 */
export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return respond(res, 405, { error: "Method Not Allowed" });
  }

  try {
    const { email, rewardId } = req.body;

    if (!email || !rewardId) {
      return respond(res, 400, { error: "Email and rewardId are required" });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    // Get reward details
    const reward = await kv.hgetall(`reward:${rewardId}`);
    if (!reward) {
      return respond(res, 404, { error: "Reward not found" });
    }

    if (reward.status !== "active") {
      return respond(res, 400, { error: "Reward is not available" });
    }

    const pointsCost = parseInt(reward.pointsCost) || 0;

    // --- Compute user's available points comprehensively (align with user-points-final) ---
    let totalPointsEarned = 0;
    let totalPointsRedeemed = 0;
    const visitedPartners = new Set();
    const processedKeys = new Set();

    // Base candidates to help discover partner id from QR record
    const possibleQrKeys = [`qr:email:${normalizedEmail}`, `qr:email:${email}`];

    const discoveredPartners = new Set();
    for (const qrKey of possibleQrKeys) {
      try {
        const rec = await kv.hgetall(qrKey);
        if (rec && Object.keys(rec).length > 0) {
          const pid = (rec.partnerId || rec.partner_id || "").toLowerCase();
          if (pid) discoveredPartners.add(pid);
        }
      } catch {}
    }

    // Load partners set and merge discovered/known ones
    const allPartners = (await kv.smembers("partners")) || [];
    const knownPartnerIds = ["osm001", "tx003", "lz001", "lz002", "olo001"];
    for (const pid of [...knownPartnerIds, ...discoveredPartners]) {
      if (!allPartners.includes(pid)) allPartners.push(pid);
    }

    // Helper to parse payload safely and derive points
    const derivePointsFromRecord = (record, payload) => {
      if (record.pointsAwarded) return parseInt(record.pointsAwarded);
      if (payload && payload.estimatedPoints)
        return parseInt(payload.estimatedPoints);
      if (payload && payload.totalPrice)
        return Math.floor(parseFloat(payload.totalPrice) / 100);
      const ticketType = (payload?.ticket || "Standard").toLowerCase();
      const numPeople = parseInt(payload?.numPeople) || 1;
      switch (ticketType) {
        case "vip":
          return 50 * numPeople;
        case "family":
          return 30 * numPeople;
        case "group":
          return 20 * numPeople;
        default:
          return 10 * numPeople;
      }
    };

    const isVisitedRecord = (record) => {
      return (
        record?.visited === "true" ||
        record?.visited === true ||
        record?.status === "Visited" ||
        record?.status === "visited" ||
        !!record?.visitedAt ||
        (record?.used === "true" && !!record?.scannedAt)
      );
    };

    for (const partnerId of allPartners) {
      const pidLower = String(partnerId).trim().toLowerCase();

      // Determine if user is associated with this partner
      const partnerEmailsLower =
        (await kv.smembers(`partner:${pidLower}`)) || [];
      const partnerEmailsUpper =
        (await kv.smembers(`partner:${partnerId.toUpperCase()}`)) || [];
      const isRegistered =
        partnerEmailsLower.includes(normalizedEmail) ||
        partnerEmailsUpper.includes(normalizedEmail) ||
        partnerEmailsUpper.includes(email);

      // If not registered, still allow if a QR record explicitly ties to this partner
      if (!isRegistered) {
        const baseKey = `qr:email:${normalizedEmail}`;
        const baseRec = await kv.hgetall(baseKey);
        if (!(baseRec && (baseRec.partnerId || baseRec.partner_id))) {
          continue;
        }
        const recPid = (
          baseRec.partnerId ||
          baseRec.partner_id ||
          ""
        ).toLowerCase();
        if (recPid !== pidLower) continue;
      }

      visitedPartners.add(pidLower);

      const keysToCheck = [
        `qr:email:${normalizedEmail}`,
        `qr:${normalizedEmail}:${pidLower}`,
        `qr:${pidLower}:${normalizedEmail}`,
      ];

      for (const key of keysToCheck) {
        if (processedKeys.has(key)) continue;
        processedKeys.add(key);
        try {
          const record = await kv.hgetall(key);
          if (!record || Object.keys(record).length === 0) continue;

          // Validate ownership by partner when present
          const recPid = (
            record.partnerId ||
            record.partner_id ||
            ""
          ).toLowerCase();
          if (recPid && recPid !== pidLower) continue;

          // Parse payload (handle double JSON)
          let payload = {};
          try {
            if (record.payload) {
              const first = JSON.parse(record.payload);
              if (
                first &&
                typeof first === "object" &&
                typeof first.data === "string"
              ) {
                try {
                  payload = JSON.parse(first.data);
                } catch {
                  payload = first;
                }
              } else {
                payload = first;
              }
            }
          } catch {
            try {
              payload = record.payload ? JSON.parse(record.payload) : {};
            } catch {
              payload = {};
            }
          }

          if (isVisitedRecord(record)) {
            totalPointsEarned += derivePointsFromRecord(record, payload);
          }
        } catch {}
      }
    }

    // Sum prior redemptions from points history
    const pointsHistory =
      (await kv.lrange(`points:history:${normalizedEmail}`, 0, -1)) || [];
    for (const item of pointsHistory) {
      try {
        const entry = typeof item === "string" ? JSON.parse(item) : item;
        if (entry?.type === "redemption" && entry.points) {
          totalPointsRedeemed += parseInt(entry.points);
        }
      } catch {}
    }

    const availablePoints = Math.max(
      0,
      totalPointsEarned - totalPointsRedeemed
    );

    // Check if user has enough points
    if (availablePoints < pointsCost) {
      return respond(res, 400, {
        error: "Insufficient points",
        required: pointsCost,
        available: availablePoints,
      });
    }

    // Check if reward is available for user's visited partners
    let availableFor = [];
    try {
      availableFor = reward.availableFor ? JSON.parse(reward.availableFor) : [];
    } catch {
      availableFor = [];
    }

    if (availableFor.length > 0) {
      const hasEligiblePartner = availableFor.some((p) =>
        visitedPartners.has(String(p).toLowerCase())
      );
      if (!hasEligiblePartner) {
        return respond(res, 400, {
          error: "Reward not available for your visited partners",
          requiredPartners: availableFor,
          yourPartners: Array.from(visitedPartners),
        });
      }
    }

    // Generate redemption code
    const redemptionCode = `RDM-${Date.now()}-${Math.random()
      .toString(36)
      .substring(2, 9)
      .toUpperCase()}`;

    // Create redemption record
    const redemption = {
      id: redemptionCode,
      email: normalizedEmail,
      rewardId,
      rewardName: reward.name,
      pointsSpent: pointsCost,
      redeemedAt: new Date().toISOString(),
      status: "pending", // pending, approved, delivered
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
    };

    // Save redemption
    await kv.lpush(
      `redemptions:${normalizedEmail}`,
      JSON.stringify(redemption)
    );
    await kv.hset(`redemption:${redemptionCode}`, redemption);

    // Add to points history
    const historyEntry = {
      type: "redemption",
      points: pointsCost,
      rewardId,
      rewardName: reward.name,
      redemptionCode,
      timestamp: new Date().toISOString(),
    };
    await kv.lpush(
      `points:history:${normalizedEmail}`,
      JSON.stringify(historyEntry)
    );

    // Update reward stock if applicable
    if (reward.stock) {
      const currentStock = parseInt(reward.stock) || 0;
      if (currentStock > 0) {
        await kv.hset(`reward:${rewardId}`, "stock", currentStock - 1);
      }
    }

    // Send notification (webhook) if configured
    if (process.env.REDEMPTION_WEBHOOK_URL) {
      fetch(process.env.REDEMPTION_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "reward_redemption",
          redemption,
          userEmail: normalizedEmail,
          timestamp: new Date().toISOString(),
        }),
      }).catch(console.error);
    }

    return respond(res, 200, {
      success: true,
      message: "Reward redeemed successfully",
      redemption: {
        code: redemptionCode,
        rewardName: reward.name,
        pointsSpent: pointsCost,
        remainingPoints: availablePoints - pointsCost,
        expiresAt: redemption.expiresAt,
        instructions:
          reward.redemptionInstructions || "Please show this code at the venue",
      },
    });
  } catch (error) {
    console.error("Error redeeming reward:", error);
    return respond(res, 500, {
      error: "Internal server error",
      message: "Failed to process redemption",
    });
  }
}
