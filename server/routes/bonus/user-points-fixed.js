import { kv } from '@vercel/kv';
import { respond, setCors } from '../../../lib/utils.js';

/**
 * GET /api/bonus/user-points
 * Fixed endpoint that properly finds ALL partner visits for a user
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

    // Initialize tracking
    let totalPointsEarned = 0;
    let totalPointsRedeemed = 0;
    const allVisits = [];
    const visitsByPartner = {};

    // Step 1: Get all partners that this user is registered with
    // Check known partner IDs and their member lists
    const knownPartnerIds = ['osm001', 'tx003', 'lz001', 'lz002', 'olo001'];
    const registeredPartners = [];

    for (const partnerId of knownPartnerIds) {
      // Check multiple case variations
      const variations = [
        partnerId.toLowerCase(),
        partnerId.toUpperCase(),
        partnerId
      ];
      
      for (const variant of variations) {
        const partnerEmails = await kv.smembers(`partner:${variant}`) || [];
        
        if (partnerEmails.includes(normalizedEmail) || 
            partnerEmails.includes(email) || 
            partnerEmails.includes(email.toLowerCase())) {
          
          registeredPartners.push({
            partnerId: partnerId.toLowerCase(),
            originalId: variant
          });
          console.log(`Found user registered with partner: ${variant}`);
          break; // Found in this partner, move to next
        }
      }
    }

    // Also check the main partners set
    const allPartnersInSystem = await kv.smembers('partners') || [];
    for (const partnerId of allPartnersInSystem) {
      const normalizedPartnerId = String(partnerId).toLowerCase();
      
      // Skip if already found
      if (registeredPartners.some(p => p.partnerId === normalizedPartnerId)) {
        continue;
      }
      
      const partnerEmails = await kv.smembers(`partner:${partnerId}`) || [];
      if (partnerEmails.includes(normalizedEmail) || partnerEmails.includes(email)) {
        registeredPartners.push({
          partnerId: normalizedPartnerId,
          originalId: partnerId
        });
        console.log(`Found user registered with partner: ${partnerId}`);
      }
    }

    console.log(`User is registered with ${registeredPartners.length} partners:`, registeredPartners);

    // Step 2: For each partner the user is registered with, create a visit record
    // Since we have a single QR record per email, we need to extract partner-specific data
    
    // Get the main QR record
    const mainQrKey = `qr:email:${normalizedEmail}`;
    const mainRecord = await kv.hgetall(mainQrKey);
    
    let mainPayload = {};
    let currentPartnerId = null;
    
    if (mainRecord && Object.keys(mainRecord).length > 0) {
      // Parse the payload - handle double encoding
      try {
        if (mainRecord.payload) {
          const firstParse = JSON.parse(mainRecord.payload);
          if (firstParse.data && typeof firstParse.data === 'string') {
            mainPayload = JSON.parse(firstParse.data);
          } else {
            mainPayload = firstParse;
          }
        }
      } catch (e) {
        console.log('Error parsing main payload:', e);
        try {
          mainPayload = mainRecord.payload ? JSON.parse(mainRecord.payload) : {};
        } catch (e2) {
          mainPayload = {};
        }
      }
      
      // Get the current partner from the record
      currentPartnerId = (
        mainRecord.partnerId || 
        mainRecord.partner_id || 
        mainPayload.partner_id ||
        mainPayload.partnerId ||
        ''
      ).toLowerCase();
      
      console.log('Main record partner:', currentPartnerId);
    }

    // Step 3: Get all visits from the user's visit set
    const userVisitsKey = `user:visits:${normalizedEmail}`;
    const userVisitKeys = await kv.smembers(userVisitsKey) || [];
    console.log(`Found ${userVisitKeys.length} visit keys for user`);
    
    // Also check the chronological visit list
    const chronoKey = `visits:chrono:${normalizedEmail}`;
    const chronoVisits = await kv.lrange(chronoKey, 0, -1) || [];
    console.log(`Found ${chronoVisits.length} chronological visits`);
    
    // Collect all unique visit records
    const allVisitRecords = new Map();
    
    // Process visit keys from set
    for (const visitKey of userVisitKeys) {
      const record = await kv.hgetall(visitKey);
      if (record && Object.keys(record).length > 0) {
        const recordPartnerId = (record.partnerId || '').toLowerCase();
        if (recordPartnerId) {
          if (!allVisitRecords.has(visitKey)) {
            allVisitRecords.set(visitKey, record);
            console.log(`Found visit record for ${recordPartnerId} from key ${visitKey}`);
          }
        }
      }
    }
    
    // Process chronological visits
    for (const chronoItem of chronoVisits) {
      try {
        const visitInfo = typeof chronoItem === 'string' ? JSON.parse(chronoItem) : chronoItem;
        if (visitInfo.qrKey) {
          const record = await kv.hgetall(visitInfo.qrKey);
          if (record && Object.keys(record).length > 0 && !allVisitRecords.has(visitInfo.qrKey)) {
            allVisitRecords.set(visitInfo.qrKey, record);
            console.log(`Found visit from chrono list: ${visitInfo.partnerId}`);
          }
        }
      } catch (e) {
        console.log('Error processing chrono visit:', e);
      }
    }
    
    // Add the main record if it exists and not already included
    if (mainRecord && Object.keys(mainRecord).length > 0) {
      const mainKey = `qr:email:${normalizedEmail}`;
      if (!allVisitRecords.has(mainKey)) {
        allVisitRecords.set(mainKey, mainRecord);
      }
    }
    
    console.log(`Total unique visit records found: ${allVisitRecords.size}`);
    
    // Step 4: Create visit records for each registered partner
    for (const { partnerId, originalId } of registeredPartners) {
      let visitData = null;
      
      // First check if we have a visit record for this partner
      for (const [key, record] of allVisitRecords) {
        const recordPartnerId = (record.partnerId || '').toLowerCase();
        if (recordPartnerId === partnerId) {
          let payload = {};
          try {
            if (record.payload) {
              const firstParse = JSON.parse(record.payload);
              if (firstParse.data && typeof firstParse.data === 'string') {
                payload = JSON.parse(firstParse.data);
              } else {
                payload = firstParse;
              }
            }
          } catch (e) {
            try {
              payload = record.payload ? JSON.parse(record.payload) : {};
            } catch (e2) {
              payload = {};
            }
          }
          
          visitData = { record, payload };
          console.log(`Matched visit for partner ${partnerId}`);
          break;
        }
      }
      
      // If not found in collected records, try additional patterns
      if (!visitData) {
        const possibleKeys = [
          `qr:${normalizedEmail}:${partnerId}`,
          `qr:${partnerId}:${normalizedEmail}`,
          `qr:email:${normalizedEmail}:${partnerId}`,
          `qr:${normalizedEmail}:${originalId}`,
          `qr:${originalId}:${normalizedEmail}`,
        ];
        
        // Also check for visits with visit IDs (new pattern)
        const partnerVisitsKey = `partner:visits:${partnerId}`;
        const partnerVisitKeys = await kv.smembers(partnerVisitsKey) || [];
        for (const pvKey of partnerVisitKeys) {
          if (pvKey.includes(normalizedEmail)) {
            possibleKeys.push(pvKey);
          }
        }
        
        for (const key of possibleKeys) {
          const record = await kv.hgetall(key);
          if (record && Object.keys(record).length > 0) {
            let payload = {};
            try {
              if (record.payload) {
                const firstParse = JSON.parse(record.payload);
                if (firstParse.data && typeof firstParse.data === 'string') {
                  payload = JSON.parse(firstParse.data);
                } else {
                  payload = firstParse;
                }
              }
            } catch (e) {
              try {
                payload = record.payload ? JSON.parse(record.payload) : {};
              } catch (e2) {
                payload = {};
              }
            }
            
            visitData = { record, payload };
            console.log(`Found visit for ${partnerId} from key pattern: ${key}`);
            break;
          }
        }
      }
      
      // If we still don't have visit data but user is registered, create a basic visit
      if (!visitData && partnerId !== currentPartnerId) {
        // User is registered but we don't have the specific QR record
        // This can happen when records are stored differently
        // Create a basic visit record
        visitData = {
          record: {
            email: normalizedEmail,
            partnerId: partnerId,
            status: 'pending',
            createdAt: new Date().toISOString()
          },
          payload: {}
        };
      }
      
      if (visitData) {
        const { record, payload } = visitData;
        
        // Determine if visited
        const isVisited = 
          record.visited === 'true' || 
          record.visited === true ||
          record.status === 'Visited' ||
          record.status === 'visited' ||
          !!record.visitedAt;
        
        // Calculate points
        let pointsForThisVisit = 0;
        
        if (isVisited) {
          if (record.pointsAwarded) {
            pointsForThisVisit = parseInt(record.pointsAwarded);
          } else if (payload.estimatedPoints) {
            pointsForThisVisit = parseInt(payload.estimatedPoints);
          } else if (payload.totalPrice) {
            pointsForThisVisit = Math.floor(parseFloat(payload.totalPrice) / 100);
          } else {
            // Default calculation
            const numPeople = parseInt(payload.numPeople) || 1;
            const ticketType = (payload.ticket || 'Standard').toLowerCase();
            
            switch (ticketType) {
              case 'vip': pointsForThisVisit = 50 * numPeople; break;
              case 'family': pointsForThisVisit = 30 * numPeople; break;
              case 'group': pointsForThisVisit = 20 * numPeople; break;
              case 'adult': pointsForThisVisit = 11; break; // Based on your data
              default: pointsForThisVisit = 10 * numPeople;
            }
          }
          
          // Add transport bonus
          if (payload.Transport === 'Yes' || payload.Bus_Rental || payload.selectedBus) {
            pointsForThisVisit += 5;
          }
        }
        
        // Create visit info
        const visitInfo = {
          partnerId: partnerId,
          partnerName: await getPartnerName(partnerId),
          visitDate: record.createdAt || new Date().toISOString(),
          confirmedDate: record.visitedAt || null,
          status: isVisited ? 'visited' : 'pending',
          ticketType: payload.ticket || 'Standard',
          numPeople: parseInt(payload.numPeople) || 1,
          transport: payload.Transport || 'No',
          busRental: payload.Bus_Rental || payload.selectedBus || '',
          cityCode: payload.cityCode || '',
          categories: payload.Categories || '',
          age: payload.Age || '',
          totalPrice: parseFloat(payload.totalPrice) || 0,
          pointsEarned: pointsForThisVisit,
          attractionName: payload.attractionName || '',
          registeredAt: record.createdAt || new Date().toISOString()
        };
        
        allVisits.push(visitInfo);
        
        if (!visitsByPartner[partnerId]) {
          visitsByPartner[partnerId] = [];
        }
        visitsByPartner[partnerId].push(visitInfo);
        
        if (isVisited) {
          totalPointsEarned += pointsForThisVisit;
          console.log(`Added ${pointsForThisVisit} points from ${partnerId}`);
        }
      }
    }

    // Step 4: Get redemption and points history
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

    // Step 5: Get available rewards
    const availablePoints = Math.max(0, totalPointsEarned - totalPointsRedeemed);
    const availableRewards = await fetchAvailableRewards(
      availablePoints,
      registeredPartners.map(p => p.partnerId)
    );

    // Sort visits by date
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

    console.log(`Final: ${allVisits.length} visits, ${totalPointsEarned} points earned`);

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
      pointsHistory: parsedPointsHistory.slice(0, 50),
      redemptions: parsedRedemptions.slice(0, 20),
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

// Helper function to get partner name
async function getPartnerName(partnerId) {
  try {
    const partnerMeta = await kv.hgetall(`partner:meta:${partnerId}`);
    if (partnerMeta && partnerMeta.name) {
      return partnerMeta.name;
    }
    
    // Try uppercase version
    const partnerMetaUpper = await kv.hgetall(`partner:meta:${partnerId.toUpperCase()}`);
    if (partnerMetaUpper && partnerMetaUpper.name) {
      return partnerMetaUpper.name;
    }
  } catch (e) {
    console.log('Error fetching partner name:', partnerId);
  }
  
  // Return formatted partner ID if no name found
  return partnerId.toUpperCase();
}

// Helper function to fetch available rewards
async function fetchAvailableRewards(availablePoints, visitedPartnerIds) {
  const rewards = [];
  
  try {
    const rewardIds = await kv.smembers('rewards') || [];
    
    for (const rewardId of rewardIds.slice(0, 50)) {
      try {
        const reward = await kv.hgetall(`reward:${rewardId}`);
        
        if (reward && reward.status === 'active') {
          let availableFor = [];
          try {
            availableFor = reward.availableFor ? JSON.parse(reward.availableFor) : [];
          } catch (e) {
            availableFor = [];
          }
          
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
    
    rewards.sort((a, b) => a.pointsCost - b.pointsCost);
    
  } catch (e) {
    console.log('Error fetching rewards:', e);
  }
  
  return rewards;
}