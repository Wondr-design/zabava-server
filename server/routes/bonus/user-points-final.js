import { kv } from '@vercel/kv';
import { respond, setCors } from '../../../lib/utils.js';

/**
 * GET /api/bonus/user-points
 * Comprehensive endpoint to fetch ALL user points from ALL partner visits
 * Handles multiple data formats and storage patterns
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
    const processedRecords = new Set(); // Track processed records to avoid duplicates
    
    // First, try to find ALL QR records for this user
    const possibleQrKeys = [
      `qr:email:${normalizedEmail}`,
      `qr:email:${email}`, // Try original case
    ];
    
    // Search for all possible QR records and extract partner IDs
    const foundPartnerIds = new Set();
    
    for (const qrKey of possibleQrKeys) {
      try {
        const record = await kv.hgetall(qrKey);
        if (record && Object.keys(record).length > 0) {
          const pid = (record.partnerId || record.partner_id || '').toLowerCase();
          if (pid) {
            foundPartnerIds.add(pid);
            console.log(`Found partner ${pid} from QR record`);
          }
        }
      } catch (e) {
        console.log('Error checking QR key:', qrKey);
      }
    }

    // Get all partners - include all possible variations
    const allPartners = await kv.smembers('partners') || [];
    
    // Also add known partner IDs that might not be in the partners set
    const knownPartnerIds = ['osm001', 'tx003', 'lz001', 'lz002', 'olo001'];
    for (const pid of knownPartnerIds) {
      if (!allPartners.includes(pid)) {
        allPartners.push(pid);
      }
    }
    
    // Add any partner IDs we found from QR records
    for (const pid of foundPartnerIds) {
      if (!allPartners.includes(pid)) {
        allPartners.push(pid);
        console.log(`Added partner ${pid} from QR records`);
      }
    }
    
    console.log('Checking all partners:', allPartners);

    // Check each partner for user visits
    for (const partnerId of allPartners) {
      const normalizedPartnerId = String(partnerId).trim().toLowerCase();
      
      // Check if user is registered with this partner
      const partnerEmails = await kv.smembers(`partner:${normalizedPartnerId}`) || [];
      
      // Also check with uppercase partner ID (in case of inconsistent storage)
      const partnerEmailsUpper = await kv.smembers(`partner:${partnerId.toUpperCase()}`) || [];
      
      const isRegistered = partnerEmails.includes(normalizedEmail) || 
                          partnerEmailsUpper.includes(normalizedEmail) ||
                          partnerEmailsUpper.includes(email); // Check original email too
      
      if (!isRegistered) {
        // Still check the QR records in case partner list wasn't updated
        const testKey = `qr:email:${normalizedEmail}`;
        const testRecord = await kv.hgetall(testKey);
        if (testRecord) {
          const testPartnerId = (testRecord.partnerId || testRecord.partner_id || '').toLowerCase();
          if (testPartnerId !== normalizedPartnerId) {
            continue; // Skip if doesn't match this partner
          }
        } else {
          continue; // Skip if no registration found
        }
      }

      console.log(`User ${normalizedEmail} is registered with partner ${normalizedPartnerId}`);

      // Try multiple key patterns to find user's records
      const keysToCheck = [
        `qr:email:${normalizedEmail}`, // Original single record
        `qr:${normalizedEmail}:${normalizedPartnerId}`, // User-partner specific
        `qr:${normalizedPartnerId}:${normalizedEmail}`, // Partner-user specific
      ];

      for (const key of keysToCheck) {
        // Skip if we've already processed this record
        if (processedRecords.has(key)) continue;
        
        try {
          const record = await kv.hgetall(key);
          
          if (!record || Object.keys(record).length === 0) continue;
          
          // Mark as processed
          processedRecords.add(key);
          
          // Check if record belongs to this partner
          const recordPartnerId = (
            record.partnerId || 
            record.partner_id || 
            ''
          ).toLowerCase();
          
          // If record has a partner ID and it doesn't match, skip
          if (recordPartnerId && recordPartnerId !== normalizedPartnerId) {
            continue;
          }

          // If no partner ID in record, assume it belongs to this partner since user is in partner's list
          if (!recordPartnerId) {
            record.partnerId = normalizedPartnerId;
          }

          // Parse payload - handle double-encoded data
          let payload = {};
          try {
            if (record.payload) {
              const firstParse = JSON.parse(record.payload);
              // Check if there's a nested 'data' field with JSON
              if (firstParse.data && typeof firstParse.data === 'string') {
                payload = JSON.parse(firstParse.data);
              } else {
                payload = firstParse;
              }
            }
          } catch (e) {
            console.log('Error parsing payload for', key);
            // Try to parse as single JSON
            try {
              payload = record.payload ? JSON.parse(record.payload) : {};
            } catch (e2) {
              payload = {};
            }
          }

          // Determine visit status - check ALL possible indicators
          const isVisited = 
            record.visited === 'true' || 
            record.visited === true ||
            record.status === 'Visited' ||
            record.status === 'visited' ||
            !!record.visitedAt ||
            record.used === 'true' && !!record.scannedAt;

          // Calculate points from various sources
          let pointsForThisVisit = 0;
          
          // Priority order for points:
          // 1. pointsAwarded (set when marked as visited)
          // 2. estimatedPoints from payload
          // 3. Calculate from price
          // 4. Default based on ticket type
          
          if (record.pointsAwarded) {
            pointsForThisVisit = parseInt(record.pointsAwarded);
          } else if (payload.estimatedPoints) {
            pointsForThisVisit = parseInt(payload.estimatedPoints);
          } else if (payload.totalPrice) {
            // 1 point per 100 currency units
            pointsForThisVisit = Math.floor(parseFloat(payload.totalPrice) / 100);
          } else {
            // Default points based on ticket type and number of people
            const ticketType = (payload.ticket || 'Standard').toLowerCase();
            const numPeople = parseInt(payload.numPeople) || 1;
            
            switch (ticketType) {
              case 'vip':
                pointsForThisVisit = 50 * numPeople;
                break;
              case 'family':
                pointsForThisVisit = 30 * numPeople;
                break;
              case 'group':
                pointsForThisVisit = 20 * numPeople;
                break;
              default:
                pointsForThisVisit = 10 * numPeople;
            }
          }

          // Add transport bonus if applicable
          if (payload.Transport === 'Yes' || payload.Bus_Rental) {
            pointsForThisVisit += 5;
          }

          // Create visit record
          const visitInfo = {
            partnerId: normalizedPartnerId,
            partnerName: await getPartnerName(normalizedPartnerId),
            visitDate: record.createdAt || new Date().toISOString(),
            confirmedDate: record.visitedAt || (isVisited ? record.scannedAt : null),
            status: isVisited ? 'visited' : 'pending',
            ticketType: payload.ticket || payload.ticketType || record.ticketType || 'Standard',
            numPeople: parseInt(payload.numPeople) || 1,
            transport: payload.Transport || 'No',
            busRental: payload.Bus_Rental || payload.selectedBus || '',
            cityCode: payload.cityCode || '',
            categories: payload.Categories || payload.categories || '',
            age: payload.Age || payload.age || '',
            totalPrice: parseFloat(payload.totalPrice) || parseFloat(record.totalPrice) || 0,
            pointsEarned: pointsForThisVisit,
            qrCode: record.qrCode || key,
            registeredAt: record.createdAt || new Date().toISOString()
          };

          allVisits.push(visitInfo);

          // Track by partner
          if (!visitsByPartner[normalizedPartnerId]) {
            visitsByPartner[normalizedPartnerId] = [];
          }
          visitsByPartner[normalizedPartnerId].push(visitInfo);

          // Only add to total if visit is confirmed
          if (isVisited) {
            totalPointsEarned += pointsForThisVisit;
            console.log(`Added ${pointsForThisVisit} points from ${normalizedPartnerId} visit`);
          }

        } catch (err) {
          console.log('Error processing key:', key, err);
        }
      }
    }

    // Also check for any records that might not be in partner lists yet
    // This handles edge cases where registration exists but partner list wasn't updated
    try {
      const mainKey = `qr:email:${normalizedEmail}`;
      if (!processedRecords.has(mainKey)) {
        const record = await kv.hgetall(mainKey);
        
        if (record && Object.keys(record).length > 0) {
          const recordPartnerId = (record.partnerId || record.partner_id || '').toLowerCase();
          
          if (recordPartnerId) {
            // Process this record similar to above
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
              console.log('Error parsing payload for main key');
              try {
                payload = record.payload ? JSON.parse(record.payload) : {};
              } catch (e2) {
                payload = {};
              }
            }

            const isVisited = 
              record.visited === 'true' || 
              record.visited === true ||
              record.status === 'Visited' ||
              !!record.visitedAt;

            let pointsForThisVisit = 0;
            if (record.pointsAwarded) {
              pointsForThisVisit = parseInt(record.pointsAwarded);
            } else if (payload.estimatedPoints) {
              pointsForThisVisit = parseInt(payload.estimatedPoints);
            } else if (payload.totalPrice) {
              pointsForThisVisit = Math.floor(parseFloat(payload.totalPrice) / 100);
            } else {
              pointsForThisVisit = 10; // Default
            }

            const visitInfo = {
              partnerId: recordPartnerId,
              partnerName: await getPartnerName(recordPartnerId),
              visitDate: record.createdAt || new Date().toISOString(),
              confirmedDate: record.visitedAt,
              status: isVisited ? 'visited' : 'pending',
              ticketType: payload.ticket || 'Standard',
              numPeople: parseInt(payload.numPeople) || 1,
              transport: payload.Transport || 'No',
              busRental: payload.Bus_Rental || '',
              cityCode: payload.cityCode || '',
              categories: payload.Categories || '',
              age: payload.Age || '',
              totalPrice: parseFloat(payload.totalPrice) || 0,
              pointsEarned: pointsForThisVisit,
              qrCode: mainKey,
              registeredAt: record.createdAt || new Date().toISOString()
            };

            // Only add if not already in visits
            const isDuplicate = allVisits.some(v => 
              v.partnerId === visitInfo.partnerId && 
              v.registeredAt === visitInfo.registeredAt
            );

            if (!isDuplicate) {
              allVisits.push(visitInfo);
              
              if (!visitsByPartner[recordPartnerId]) {
                visitsByPartner[recordPartnerId] = [];
              }
              visitsByPartner[recordPartnerId].push(visitInfo);

              if (isVisited) {
                totalPointsEarned += pointsForThisVisit;
              }
            }
          }
        }
      }
    } catch (err) {
      console.log('Error checking main record:', err);
    }

    // Get redemption history
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
        
        // Also use points history to reconcile total
        if (entry.type === 'earned' && entry.points) {
          // Check if this is already counted
          const visitMatch = allVisits.find(v => 
            v.partnerId === (entry.partnerId || '').toLowerCase() &&
            v.status === 'visited'
          );
          
          if (!visitMatch) {
            // This is an earned point not in visits, add it
            totalPointsEarned += parseInt(entry.points);
            console.log(`Added ${entry.points} points from history`);
          }
        }
      } catch (e) {
        console.log('Error parsing points history:', e);
      }
    }

    // Calculate available points
    const availablePoints = Math.max(0, totalPointsEarned - totalPointsRedeemed);

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

    console.log(`Final totals: Earned=${totalPointsEarned}, Redeemed=${totalPointsRedeemed}, Available=${availablePoints}`);

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