import { kv } from '@vercel/kv';
import { respond, setCors } from '../../../lib/utils.js';

/**
 * GET /api/bonus/user-points
 * Fetch user's total points, visit history, and available rewards
 * Query params: email (required)
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
    console.log('Fetching points for:', normalizedEmail);

    // Fetch all user visits and calculate total points
    const allPartners = await kv.smembers('partners') || [];
    const visits = [];
    let totalPoints = 0;
    let totalRedeemed = 0;

    // Check each partner for user visits
    for (const partnerId of allPartners) {
      const partnerEmails = await kv.smembers(`partner:${partnerId}`) || [];
      
      if (partnerEmails.includes(normalizedEmail)) {
        // Get registration record - user might have multiple records with different partners
        const recordKey = `qr:email:${normalizedEmail}:${partnerId}`;
        let record = await kv.hgetall(recordKey);
        
        // Fallback to old key format if new format doesn't exist
        if (!record || Object.keys(record).length === 0) {
          const oldKey = `qr:email:${normalizedEmail}`;
          const oldRecord = await kv.hgetall(oldKey);
          // Check if this record belongs to this partner
          if (oldRecord && oldRecord.partnerId === partnerId) {
            record = oldRecord;
          }
        }
        
        if (record && Object.keys(record).length > 0) {
          let payload = {};
          try {
            payload = record.payload ? JSON.parse(record.payload) : {};
          } catch (e) {
            console.log('Error parsing payload for', normalizedEmail, partnerId);
          }
          
          const points = parseInt(payload.estimatedPoints) || 0;
          
          // Get partner metadata
          const partnerMeta = await kv.hgetall(`partner:meta:${partnerId}`) || {};
          
          visits.push({
            partnerId,
            partnerName: partnerMeta.name || partnerId.toUpperCase(),
            visitDate: record.visitedAt || record.scannedAt || record.createdAt || new Date().toISOString(),
            pointsEarned: points,
            status: record.visited === 'true' ? 'visited' : 'pending',
            ticketType: payload.ticket || 'Standard'
          });
          
          if (record.visited === 'true') {
            totalPoints += points;
          }
        }
      }
    }

    // Get points history (earned and redeemed)
    const pointsHistory = await kv.lrange(`points:history:${normalizedEmail}`, 0, -1) || [];
    const parsedHistory = pointsHistory.map(item => {
      try {
        return typeof item === 'string' ? JSON.parse(item) : item;
      } catch {
        return item;
      }
    });

    // Calculate redeemed points
    parsedHistory.forEach(entry => {
      if (entry.type === 'redemption') {
        totalRedeemed += entry.points;
      }
    });

    // Get available rewards
    const allRewards = await kv.smembers('rewards') || [];
    const availableRewards = [];
    
    for (const rewardId of allRewards) {
      const reward = await kv.hgetall(`reward:${rewardId}`);
      if (reward && reward.status === 'active') {
        const rewardData = {
          id: rewardId,
          name: reward.name,
          description: reward.description,
          pointsCost: parseInt(reward.pointsCost) || 0,
          category: reward.category,
          imageUrl: reward.imageUrl,
          availableFor: reward.availableFor ? JSON.parse(reward.availableFor) : [],
          canRedeem: (totalPoints - totalRedeemed) >= parseInt(reward.pointsCost)
        };
        
        // Check if user has visited any eligible partner
        const visitedPartners = visits.map(v => v.partnerId);
        const isEligible = rewardData.availableFor.length === 0 || 
                          rewardData.availableFor.some(p => visitedPartners.includes(p));
        
        if (isEligible) {
          availableRewards.push(rewardData);
        }
      }
    }

    // Get user's redemption history
    const redemptions = await kv.lrange(`redemptions:${normalizedEmail}`, 0, -1) || [];
    const parsedRedemptions = redemptions.map(item => {
      try {
        return typeof item === 'string' ? JSON.parse(item) : item;
      } catch {
        return item;
      }
    });

    // Sort visits by date (most recent first)
    visits.sort((a, b) => new Date(b.visitDate) - new Date(a.visitDate));
    
    // Sort rewards by points cost
    availableRewards.sort((a, b) => a.pointsCost - b.pointsCost);

    const response = {
      user: {
        email: normalizedEmail,
        totalPoints,
        redeemedPoints: totalRedeemed,
        availablePoints: totalPoints - totalRedeemed
      },
      statistics: {
        totalVisits: visits.filter(v => v.status === 'visited').length,
        pendingVisits: visits.filter(v => v.status === 'pending').length,
        totalPartners: new Set(visits.map(v => v.partnerId)).size,
        totalRedemptions: parsedRedemptions.length
      },
      visits,
      pointsHistory: parsedHistory.slice(0, 20), // Last 20 entries
      redemptions: parsedRedemptions.slice(0, 10), // Last 10 redemptions
      availableRewards,
      lastUpdated: new Date().toISOString()
    };

    return respond(res, 200, response);

  } catch (error) {
    console.error('Error fetching user points:', error);
    return respond(res, 500, { 
      error: 'Internal server error',
      message: 'Failed to fetch user points data'
    });
  }
}