import { kv } from '@vercel/kv';
import { respond, setCors } from '../../../lib/utils.js';

/**
 * Simplified GET /api/bonus/user-points
 * Fetch user's total points and available rewards
 */
export default async function handler(req, res) {
  setCors(res);
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return respond(res, 405, { error: 'Method Not Allowed' });
  }

  try {
    const { email } = req.query;
    
    if (!email) {
      return respond(res, 400, { error: 'Email is required' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    // Initialize response structure
    const response = {
      user: {
        email: normalizedEmail,
        totalPoints: 0,
        redeemedPoints: 0,
        availablePoints: 0
      },
      statistics: {
        totalVisits: 0,
        pendingVisits: 0,
        totalPartners: 0,
        totalRedemptions: 0
      },
      visits: [],
      pointsHistory: [],
      redemptions: [],
      availableRewards: [],
      lastUpdated: new Date().toISOString()
    };

    try {
      // Get the main QR record
      const mainRecord = await kv.hgetall(`qr:email:${normalizedEmail}`);
      
      if (mainRecord && Object.keys(mainRecord).length > 0) {
        let payload = {};
        try {
          payload = mainRecord.payload ? JSON.parse(mainRecord.payload) : {};
        } catch (e) {
          console.log('Error parsing payload');
        }
        
        const points = parseInt(payload.estimatedPoints) || 0;
        const partnerId = mainRecord.partnerId || payload.partner_id || 'unknown';
        
        // Add visit record
        response.visits.push({
          partnerId: partnerId,
          partnerName: partnerId.toUpperCase(),
          visitDate: mainRecord.visitedAt || mainRecord.scannedAt || mainRecord.createdAt || new Date().toISOString(),
          pointsEarned: points,
          status: mainRecord.visited === 'true' ? 'visited' : 'pending',
          ticketType: payload.ticket || 'Standard'
        });
        
        // Calculate points if visited
        if (mainRecord.visited === 'true') {
          response.user.totalPoints = points;
          response.user.availablePoints = points;
          response.statistics.totalVisits = 1;
        } else {
          response.statistics.pendingVisits = 1;
        }
        
        response.statistics.totalPartners = 1;
      }
      
      // Get all rewards (simplified)
      const rewardIds = await kv.smembers('rewards') || [];
      
      for (const rewardId of rewardIds.slice(0, 10)) { // Limit to first 10 rewards
        try {
          const reward = await kv.hgetall(`reward:${rewardId}`);
          if (reward && reward.status === 'active') {
            response.availableRewards.push({
              id: rewardId,
              name: reward.name || 'Reward',
              description: reward.description || '',
              pointsCost: parseInt(reward.pointsCost) || 100,
              category: reward.category || 'other',
              canRedeem: response.user.availablePoints >= (parseInt(reward.pointsCost) || 100),
              availableFor: []
            });
          }
        } catch (e) {
          console.log('Error fetching reward:', rewardId);
        }
      }
      
    } catch (innerError) {
      console.log('Error in data fetching:', innerError);
      // Return the empty response structure
    }

    return respond(res, 200, response);

  } catch (error) {
    console.error('Error in user-points handler:', error);
    return respond(res, 500, { 
      error: 'Internal server error',
      message: 'Failed to fetch user points data',
      details: error.message
    });
  }
}