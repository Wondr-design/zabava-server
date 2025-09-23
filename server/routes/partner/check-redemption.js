import { kv } from "@vercel/kv";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function respond(res, status, payload) {
  return res.status(status).json(payload);
}

/**
 * GET /api/partner/check-redemption?code=RDM-XXX
 * POST /api/partner/process-redemption
 * Allows partners to check redemption details and mark as used
 */
export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Extract partner auth token
  const authHeader = req.headers.authorization;
  let partnerId = null;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    try {
      const token = authHeader.substring(7);
      const payload = jwt.verify(token, JWT_SECRET);
      partnerId = payload.partnerId;
    } catch (err) {
      console.error("Auth error:", err);
    }
  }

  if (req.method === "GET") {
    // Check redemption details
    const { code } = req.query;
    
    if (!code) {
      return respond(res, 400, { error: "Redemption code is required" });
    }

    try {
      const redemptionKey = `redemption:${code}`;
      const redemption = await kv.hgetall(redemptionKey);

      if (!redemption) {
        return respond(res, 404, { 
          error: "Redemption not found",
          code 
        });
      }

      // Get the associated booking if exists
      let bookingInfo = null;
      if (redemption.appliedToBooking) {
        const bookingData = await kv.hgetall(redemption.appliedToBooking);
        if (bookingData) {
          let payload = {};
          try {
            payload = JSON.parse(bookingData.payload || "{}");
          } catch {}

          bookingInfo = {
            email: bookingData.email,
            visitDate: bookingData.createdAt,
            partnerId: payload.partner_id || payload.partnerId,
            partnerName: payload.attractionName,
            ticketType: payload.ticket,
            numPeople: payload.numPeople,
            preferredDateTime: payload.preferredDateTime,
            hasVisited: bookingData.visited === "true",
            visitedAt: bookingData.visitedAt
          };
        }
      }

      // Get reward details
      const rewardKey = `reward:${redemption.rewardId}`;
      const reward = await kv.hgetall(rewardKey);

      return respond(res, 200, {
        redemption: {
          code: code,
          email: redemption.email,
          status: redemption.status,
          redeemedAt: redemption.redeemedAt,
          appliedAt: redemption.appliedAt,
          usedAt: redemption.usedAt,
          expiresAt: redemption.expiresAt,
          partnerId: redemption.partnerId
        },
        reward: {
          name: redemption.rewardName,
          description: reward?.description,
          category: reward?.category,
          pointsValue: redemption.pointsSpent,
          instructions: reward?.redemptionInstructions
        },
        booking: bookingInfo,
        isValid: redemption.status === "applied" && new Date(redemption.expiresAt) > new Date(),
        canProcess: partnerId && (redemption.partnerId === partnerId || !redemption.partnerId)
      });
    } catch (error) {
      console.error("Error checking redemption:", error);
      return respond(res, 500, { 
        error: "Failed to check redemption",
        message: error.message 
      });
    }
  }

  if (req.method === "POST") {
    // Process/mark redemption as used
    if (!partnerId) {
      return respond(res, 401, { error: "Authentication required" });
    }

    const { code, action } = req.body;
    
    if (!code || !action) {
      return respond(res, 400, { 
        error: "Code and action are required" 
      });
    }

    if (!["process", "reject"].includes(action)) {
      return respond(res, 400, { 
        error: "Invalid action. Use 'process' or 'reject'" 
      });
    }

    try {
      const redemptionKey = `redemption:${code}`;
      const redemption = await kv.hgetall(redemptionKey);

      if (!redemption) {
        return respond(res, 404, { 
          error: "Redemption not found" 
        });
      }

      if (redemption.status === "used") {
        return respond(res, 400, { 
          error: "Redemption has already been processed" 
        });
      }

      if (redemption.status !== "applied") {
        return respond(res, 400, { 
          error: "Redemption is not in applied state",
          currentStatus: redemption.status
        });
      }

      const now = new Date().toISOString();

      if (action === "process") {
        // Mark as used/delivered
        await kv.hset(redemptionKey, {
          status: "used",
          processedBy: partnerId,
          processedAt: now
        });

        // Send webhook notification if configured
        if (process.env.REDEMPTION_PROCESSED_WEBHOOK_URL) {
          fetch(process.env.REDEMPTION_PROCESSED_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: "redemption_processed",
              code,
              partnerId,
              processedAt: now,
              userEmail: redemption.email,
              rewardName: redemption.rewardName
            })
          }).catch(console.error);
        }

        return respond(res, 200, {
          success: true,
          message: "Redemption processed successfully",
          code,
          status: "used",
          processedAt: now
        });
      } else {
        // Reject redemption
        await kv.hset(redemptionKey, {
          status: "rejected",
          rejectedBy: partnerId,
          rejectedAt: now
        });

        return respond(res, 200, {
          success: true,
          message: "Redemption rejected",
          code,
          status: "rejected",
          rejectedAt: now
        });
      }
    } catch (error) {
      console.error("Error processing redemption:", error);
      return respond(res, 500, { 
        error: "Failed to process redemption",
        message: error.message 
      });
    }
  }

  return respond(res, 405, { error: "Method not allowed" });
}