import { kv } from '@vercel/kv';
import { respond, setCors } from '../../../lib/utils.js';

/**
 * GET /api/bonus/user-points
 * Fetch user's total points from ALL visits to ALL partners
 * Points are only counted when partner marks visit as confirmed
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
    console.log('Fetching comprehensive points for:', normalizedEmail);

    // Initialize tracking variables
    let totalPointsEarned = 0;
    let totalPointsRedeemed = 0;
    const allVisits = [];
    const visitsByPartner = {};
    
    // Get all partners in the system
    const allPartners = await kv.smembers('partners') || [];
    console.log('Found partners:', allPartners);

    // For each partner, check ALL visits by this user
    for (const partnerId of allPartners) {
      const normalizedPartnerId = String(partnerId).trim().toLowerCase();
      
      // Get all registration keys for this user
      // We need to check multiple possible key formats since users can visit multiple times
      const possibleKeys = [
        `qr:email:${normalizedEmail}`,  // Original format
        `qr:${normalizedEmail}:${normalizedPartnerId}`,  // Partner-specific format
        `qr:${normalizedPartnerId}:${normalizedEmail}`,  // Alternative format
      ];

      // Also check if user is in partner's email list
      const partnerEmails = await kv.smembers(`partner:${normalizedPartnerId}`) || [];
      const isRegisteredWithPartner = partnerEmails.includes(normalizedEmail);
      
      if (!isRegisteredWithPartner) {
        continue; // Skip if user never registered with this partner
      }

      // Try to fetch the user's registration record(s) for this partner
      for (const key of possibleKeys) {
        try {
          const record = await kv.hgetall(key);
          
          if (record && Object.keys(record).length > 0) {
            // Check if this record belongs to this partner
            const recordPartnerId = (record.partnerId || record.partner_id || '').toLowerCase();
            if (recordPartnerId !== normalizedPartnerId && recordPartnerId !== '') {
              continue; // Skip if record belongs to different partner
            }

            // Parse the payload to get visit details
            let payload = {};
            try {
              payload = record.payload ? JSON.parse(record.payload) : {};
            } catch (e) {
              console.log('Error parsing payload for', key);
              payload = {};
            }

            // Extract visit information
            // Check multiple fields to determine if visited
            const isVisited = record.visited === 'true' || 
                             record.visited === true || 
                             record.visitedAt || 
                             record.status === 'Visited';
            
            const visitInfo = {
              partnerId: normalizedPartnerId,
              partnerName: await getPartnerName(normalizedPartnerId),
              visitDate: record.scannedAt || record.createdAt || new Date().toISOString(),
              confirmedDate: record.visitedAt || null,
              status: isVisited ? 'visited' : record.used === 'true' ? 'used' : 'pending',
              ticketType: payload.ticket || record.ticketType || 'Standard',
              numPeople: parseInt(payload.numPeople) || 1,
              transport: payload.Transport || 'No',
              busRental: payload.Bus_Rental || payload.selectedBus || '',
              cityCode: payload.cityCode || '',
              categories: payload.Categories || '',
              age: payload.Age || '',
              totalPrice: parseFloat(payload.totalPrice) || 0,
              pointsEarned: parseInt(payload.estimatedPoints) || calculatePoints(payload),
              qrCode: record.qrCode || key,
              registeredAt: record.createdAt || new Date().toISOString()
            };

            // Add to visits list
            allVisits.push(visitInfo);

            // Track visits by partner
            if (!visitsByPartner[normalizedPartnerId]) {
              visitsByPartner[normalizedPartnerId] = [];
            }
            visitsByPartner[normalizedPartnerId].push(visitInfo);

            // Only count points if visit is confirmed by partner
            if (isVisited) {
              // Use pointsAwarded if available (set by mark-visited), otherwise use estimated/calculated points
              const actualPoints = record.pointsAwarded ? parseInt(record.pointsAwarded) : 
                                  (parseInt(payload.estimatedPoints) || calculatePoints(payload));
              totalPointsEarned += actualPoints;
              visitInfo.pointsEarned = actualPoints; // Update the visit info with actual points
            }
          }
        } catch (err) {
          console.log('Error fetching key:', key, err);
        }
      }

      // Check for multiple visit records (user can visit same partner multiple times)
      // Look for timestamped records
      const visitPattern = `visits:${normalizedPartnerId}:${normalizedEmail}:*`;
      try {
        const visitKeys = await kv.keys(visitPattern);
        for (const visitKey of visitKeys || []) {
          const visitRecord = await kv.hgetall(visitKey);
          if (visitRecord && Object.keys(visitRecord).length > 0) {
            let payload = {};
            try {
              payload = visitRecord.payload ? JSON.parse(visitRecord.payload) : {};
            } catch (e) {
              payload = {};
            }

            const visitInfo = {
              partnerId: normalizedPartnerId,
              partnerName: await getPartnerName(normalizedPartnerId),
              visitDate: visitRecord.scannedAt || visitRecord.createdAt || new Date().toISOString(),
              confirmedDate: visitRecord.visitedAt || null,
              status: visitRecord.visited === 'true' ? 'visited' : 'pending',
              ticketType: payload.ticket || visitRecord.ticketType || 'Standard',
              numPeople: parseInt(payload.numPeople) || 1,
              transport: payload.Transport || 'No',
              busRental: payload.Bus_Rental || '',
              cityCode: payload.cityCode || '',
              categories: payload.Categories || '',
              age: payload.Age || '',
              totalPrice: parseFloat(payload.totalPrice) || 0,
              pointsEarned: parseInt(payload.estimatedPoints) || calculatePoints(payload),
              qrCode: visitRecord.qrCode || visitKey,
              registeredAt: visitRecord.createdAt || new Date().toISOString()
            };

            allVisits.push(visitInfo);
            
            if (!visitsByPartner[normalizedPartnerId]) {
              visitsByPartner[normalizedPartnerId] = [];
            }
            visitsByPartner[normalizedPartnerId].push(visitInfo);

            if (visitRecord.visited === 'true') {
              totalPointsEarned += visitInfo.pointsEarned;
            }
          }
        }
      } catch (err) {
        console.log('Error checking visit pattern:', visitPattern);
      }
    }

    // Get points redemption history
    const redemptionHistory = await kv.lrange(`redemptions:${normalizedEmail}`, 0, -1) || [];
    const parsedRedemptions = [];
    
    for (const item of redemptionHistory) {
      try {
        const redemption = typeof item === 'string' ? JSON.parse(item) : item;
        parsedRedemptions.push(redemption);
        totalPointsRedeemed += parseInt(redemption.pointsSpent) || 0;
      } catch (e) {
        console.log('Error parsing redemption:', e);
      }
    }

    // Get points history
    const pointsHistory = await kv.lrange(`points:history:${normalizedEmail}`, 0, -1) || [];
    const parsedPointsHistory = [];
    
    for (const item of pointsHistory) {
      try {
        const entry = typeof item === 'string' ? JSON.parse(item) : item;
        parsedPointsHistory.push(entry);
      } catch (e) {
        console.log('Error parsing points history:', e);
      }
    }

    // Calculate available points (earned - redeemed)
    const availablePoints = totalPointsEarned - totalPointsRedeemed;

    // Get available rewards
    const availableRewards = await fetchAvailableRewards(
      availablePoints, 
      Object.keys(visitsByPartner)
    );

    // Sort visits by date (most recent first)
    allVisits.sort((a, b) => new Date(b.visitDate) - new Date(a.visitDate));

    // Build statistics
    const statistics = {
      totalVisits: allVisits.filter(v => v.status === 'visited').length,
      pendingVisits: allVisits.filter(v => v.status === 'pending').length,
      totalPartners: Object.keys(visitsByPartner).length,
      totalRedemptions: parsedRedemptions.length,
      visitsByPartner: Object.keys(visitsByPartner).map(partnerId => ({
        partnerId,
        partnerName: visitsByPartner[partnerId][0]?.partnerName || partnerId.toUpperCase(),
        totalVisits: visitsByPartner[partnerId].filter(v => v.status === 'visited').length,
        pendingVisits: visitsByPartner[partnerId].filter(v => v.status === 'pending').length,
        totalPoints: visitsByPartner[partnerId]
          .filter(v => v.status === 'visited')
          .reduce((sum, v) => sum + v.pointsEarned, 0)
      }))
    };

    // Build response
    const response = {
      user: {
        email: normalizedEmail,
        totalPoints: totalPointsEarned,
        redeemedPoints: totalPointsRedeemed,
        availablePoints: availablePoints
      },
      statistics,
      visits: allVisits,
      pointsHistory: parsedPointsHistory.slice(0, 50), // Last 50 entries
      redemptions: parsedRedemptions.slice(0, 20), // Last 20 redemptions
      availableRewards,
      lastUpdated: new Date().toISOString()
    };

    return respond(res, 200, response);

  } catch (error) {
    console.error('Error fetching user points:', error);
    return respond(res, 500, { 
      error: 'Internal server error',
      message: 'Failed to fetch user points data',
      details: error.message
    });
  }
}

// Helper function to calculate points based on ticket details
function calculatePoints(payload) {
  // Base points calculation logic
  let points = 0;
  
  // Points based on ticket type
  const ticketType = payload.ticket || 'Standard';
  const numPeople = parseInt(payload.numPeople) || 1;
  const totalPrice = parseFloat(payload.totalPrice) || 0;
  
  // Simple calculation: 1 point per 100 currency units spent
  if (totalPrice > 0) {
    points = Math.floor(totalPrice / 100);
  } else {
    // Fallback: points based on ticket type
    switch (ticketType.toLowerCase()) {
      case 'vip':
        points = 50 * numPeople;
        break;
      case 'family':
        points = 30 * numPeople;
        break;
      case 'group':
        points = 20 * numPeople;
        break;
      default:
        points = 10 * numPeople;
    }
  }
  
  // Bonus points for transport
  if (payload.Transport === 'Yes' || payload.Bus_Rental) {
    points += 5;
  }
  
  return points;
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

// Helper function to fetch available rewards
async function fetchAvailableRewards(availablePoints, visitedPartnerIds) {
  const rewards = [];
  
  try {
    const rewardIds = await kv.smembers('rewards') || [];
    
    for (const rewardId of rewardIds.slice(0, 50)) { // Limit to 50 rewards
      try {
        const reward = await kv.hgetall(`reward:${rewardId}`);
        
        if (reward && reward.status === 'active') {
          // Parse available partners for this reward
          let availableFor = [];
          try {
            availableFor = reward.availableFor ? JSON.parse(reward.availableFor) : [];
          } catch (e) {
            availableFor = [];
          }
          
          // Check if user is eligible (has visited required partners or reward is for all)
          const isEligible = availableFor.length === 0 || 
                            availableFor.some(p => visitedPartnerIds.includes(p.toLowerCase()));
          
          if (isEligible) {
            rewards.push({
              id: rewardId,
              name: reward.name || 'Reward',
              description: reward.description || '',
              pointsCost: parseInt(reward.pointsCost) || 0,
              category: reward.category || 'other',
              imageUrl: reward.imageUrl || '',
              canRedeem: availablePoints >= (parseInt(reward.pointsCost) || 0),
              availableFor,
              stock: reward.stock ? parseInt(reward.stock) : null,
              validUntil: reward.validUntil || null
            });
          }
        }
      } catch (e) {
        console.log('Error fetching reward:', rewardId);
      }
    }
    
    // Sort rewards by points cost
    rewards.sort((a, b) => a.pointsCost - b.pointsCost);
    
  } catch (e) {
    console.log('Error fetching rewards:', e);
  }
  
  return rewards;
}