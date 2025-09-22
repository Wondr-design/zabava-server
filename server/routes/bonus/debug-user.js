import { kv } from '@vercel/kv';
import { respond, setCors } from '../../../lib/utils.js';

/**
 * GET /api/bonus/debug-user
 * Debug endpoint to see all data for a user
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
    
    const debug = {
      email: normalizedEmail,
      qrRecords: {},
      partnerMemberships: {},
      pointsHistory: [],
      redemptions: []
    };

    // Check main QR record
    const mainKey = `qr:email:${normalizedEmail}`;
    const mainRecord = await kv.hgetall(mainKey);
    if (mainRecord) {
      let parsedPayload = null;
      try {
        parsedPayload = mainRecord.payload ? JSON.parse(mainRecord.payload) : null;
      } catch (e) {
        parsedPayload = mainRecord.payload; // Keep as string if not parseable
      }
      debug.qrRecords[mainKey] = {
        ...mainRecord,
        payload: parsedPayload
      };
    }

    // Check all known partners
    const partners = ['osm001', 'tx003', 'lz001', 'lz002', 'olo001'];
    
    for (const partnerId of partners) {
      // Check if user is in partner's email list (multiple case variations)
      const variations = [
        partnerId.toLowerCase(),
        partnerId.toUpperCase(),
        partnerId
      ];
      
      for (const variant of variations) {
        const emails = await kv.smembers(`partner:${variant}`) || [];
        if (emails.includes(normalizedEmail) || emails.includes(email)) {
          debug.partnerMemberships[variant] = true;
          
          // Check for partner-specific QR records
          const partnerKeys = [
            `qr:${normalizedEmail}:${variant}`,
            `qr:${variant}:${normalizedEmail}`,
            `qr:email:${normalizedEmail}:${variant}`
          ];
          
          for (const key of partnerKeys) {
            const record = await kv.hgetall(key);
            if (record && Object.keys(record).length > 0) {
              let parsedPayload = null;
              try {
                parsedPayload = record.payload ? JSON.parse(record.payload) : null;
              } catch (e) {
                parsedPayload = record.payload;
              }
              debug.qrRecords[key] = {
                ...record,
                payload: parsedPayload
              };
            }
          }
        }
      }
    }

    // Get points history
    const pointsHistory = await kv.lrange(`points:history:${normalizedEmail}`, 0, 10) || [];
    debug.pointsHistory = pointsHistory.map(item => {
      try {
        return typeof item === 'string' ? JSON.parse(item) : item;
      } catch {
        return item;
      }
    });

    // Get redemptions
    const redemptions = await kv.lrange(`redemptions:${normalizedEmail}`, 0, 10) || [];
    debug.redemptions = redemptions.map(item => {
      try {
        return typeof item === 'string' ? JSON.parse(item) : item;
      } catch {
        return item;
      }
    });

    return respond(res, 200, debug);

  } catch (error) {
    console.error('Debug error:', error);
    return respond(res, 500, {
      error: 'Internal server error',
      message: error.message
    });
  }
}