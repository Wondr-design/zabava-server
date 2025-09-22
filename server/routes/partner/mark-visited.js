import { kv } from '@vercel/kv';
import { z } from 'zod';

/**
 * POST /api/partner/mark-visited
 * Mark a user as visited and award points
 * This is called when a partner confirms that a user actually visited
 */

const markVisitedSchema = z.object({
  email: z.string().email(),
  partnerId: z.string(),
  visitDate: z.string().optional(),
  notes: z.string().optional()
});

export default async function handler(req, res) {
  // CORS headers
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Validate request body
    const validation = markVisitedSchema.safeParse(req.body);
    
    if (!validation.success) {
      return res.status(400).json({
        error: 'Invalid request',
        details: validation.error.flatten()
      });
    }

    const { email, partnerId, visitDate, notes } = validation.data;
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPartnerId = partnerId.trim().toLowerCase();
    
    console.log(`Marking visit for ${normalizedEmail} at partner ${normalizedPartnerId}`);

    // Get the registration record
    const recordKey = `qr:email:${normalizedEmail}`;
    const record = await kv.hgetall(recordKey);
    
    if (!record || Object.keys(record).length === 0) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    // Check if this registration belongs to the specified partner
    const recordPartnerId = (record.partnerId || record.partner_id || '').toLowerCase();
    if (recordPartnerId !== normalizedPartnerId) {
      return res.status(400).json({ 
        error: 'Registration does not belong to this partner',
        expected: normalizedPartnerId,
        found: recordPartnerId
      });
    }

    // Check if already marked as visited
    if (record.visited === 'true') {
      return res.status(400).json({ 
        error: 'Already marked as visited',
        visitedAt: record.visitedAt
      });
    }

    // Parse the payload to calculate points
    let payload = {};
    let pointsEarned = 0;
    
    try {
      payload = record.payload ? JSON.parse(record.payload) : {};
      
      // Calculate points based on the registration details
      const totalPrice = parseFloat(payload.totalPrice) || 0;
      const numPeople = parseInt(payload.numPeople) || 1;
      const ticketType = payload.ticket || 'Standard';
      
      // Points calculation: 1 point per 100 units spent
      if (payload.estimatedPoints) {
        pointsEarned = parseInt(payload.estimatedPoints);
      } else if (totalPrice > 0) {
        pointsEarned = Math.floor(totalPrice / 100);
      } else {
        // Fallback calculation based on ticket type
        switch (ticketType.toLowerCase()) {
          case 'vip':
            pointsEarned = 50 * numPeople;
            break;
          case 'family':
            pointsEarned = 30 * numPeople;
            break;
          case 'group':
            pointsEarned = 20 * numPeople;
            break;
          default:
            pointsEarned = 10 * numPeople;
        }
      }
      
      // Bonus for transport
      if (payload.Transport === 'Yes' || payload.Bus_Rental) {
        pointsEarned += 5;
      }
    } catch (e) {
      console.error('Error parsing payload:', e);
      pointsEarned = 10; // Default points
    }

    // Update the record to mark as visited
    const now = visitDate || new Date().toISOString();
    const updatedRecord = {
      ...record,
      visited: 'true',
      visitedAt: now,
      pointsAwarded: pointsEarned,
      visitNotes: notes || '',
      lastUpdated: now
    };

    // Save the updated record
    await kv.hset(recordKey, updatedRecord);

    // Add to points history
    const historyEntry = {
      type: 'earned',
      points: pointsEarned,
      partnerId: normalizedPartnerId,
      partnerName: await getPartnerName(normalizedPartnerId),
      timestamp: now,
      ticketType: payload.ticket || 'Standard',
      visitId: recordKey
    };
    
    await kv.lpush(`points:history:${normalizedEmail}`, JSON.stringify(historyEntry));

    // Create a visit confirmation record for tracking
    const visitConfirmation = {
      email: normalizedEmail,
      partnerId: normalizedPartnerId,
      visitDate: now,
      pointsAwarded: pointsEarned,
      ticketType: payload.ticket || 'Standard',
      numPeople: payload.numPeople || 1,
      totalPrice: payload.totalPrice || 0,
      transport: payload.Transport || 'No',
      categories: payload.Categories || '',
      confirmationId: `visit-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
    };
    
    // Store visit confirmation
    await kv.lpush(`visits:confirmed:${normalizedPartnerId}`, JSON.stringify(visitConfirmation));
    await kv.lpush(`visits:user:${normalizedEmail}`, JSON.stringify(visitConfirmation));

    // Send notification webhook if configured
    if (process.env.VISIT_WEBHOOK_URL) {
      fetch(process.env.VISIT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'visit_confirmed',
          ...visitConfirmation
        })
      }).catch(console.error);
    }

    // Return success response
    return res.status(200).json({
      success: true,
      message: 'Visit confirmed successfully',
      visit: {
        email: normalizedEmail,
        partnerId: normalizedPartnerId,
        visitedAt: now,
        pointsAwarded: pointsEarned,
        totalPointsNow: await getUserTotalPoints(normalizedEmail)
      }
    });

  } catch (error) {
    console.error('Error marking visit:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: 'Failed to mark visit'
    });
  }
}

// Helper function to get partner name
async function getPartnerName(partnerId) {
  try {
    const partnerMeta = await kv.hgetall(`partner:meta:${partnerId}`);
    if (partnerMeta && partnerMeta.name) {
      return partnerMeta.name;
    }
  } catch (e) {
    console.log('Error fetching partner name:', partnerId);
  }
  return partnerId.toUpperCase();
}

// Helper function to get user's total points
async function getUserTotalPoints(email) {
  try {
    let totalPoints = 0;
    
    // Get all partners
    const partners = await kv.smembers('partners') || [];
    
    // Check each partner for user's visits
    for (const partnerId of partners) {
      const partnerEmails = await kv.smembers(`partner:${partnerId}`) || [];
      if (partnerEmails.includes(email)) {
        const recordKey = `qr:email:${email}`;
        const record = await kv.hgetall(recordKey);
        
        if (record && record.visited === 'true') {
          totalPoints += parseInt(record.pointsAwarded) || 0;
        }
      }
    }
    
    // Also check points history
    const history = await kv.lrange(`points:history:${email}`, 0, -1) || [];
    for (const item of history) {
      try {
        const entry = JSON.parse(item);
        if (entry.type === 'earned') {
          totalPoints += parseInt(entry.points) || 0;
        } else if (entry.type === 'redemption') {
          totalPoints -= parseInt(entry.points) || 0;
        }
      } catch (e) {
        // Skip invalid entries
      }
    }
    
    return totalPoints;
  } catch (e) {
    console.error('Error calculating total points:', e);
    return 0;
  }
}