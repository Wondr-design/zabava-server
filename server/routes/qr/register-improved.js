import { kv } from '@vercel/kv';
import { respond, setCors } from '../../../lib/utils.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * POST /api/qr/register
 * Improved registration that stores each partner visit as a separate record
 */
export default async function handler(req, res) {
  setCors(res);
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return respond(res, 405, { error: 'Method Not Allowed' });
  }

  try {
    const { email, partnerId, data } = req.body;
    
    if (!email || !partnerId) {
      return respond(res, 400, { 
        error: 'Bad Request',
        message: 'Email and partnerId are required'
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const normalizedPartnerId = String(partnerId).trim().toLowerCase();
    
    console.log('Registering QR:', {
      email: normalizedEmail,
      partnerId: normalizedPartnerId,
      hasData: !!data
    });

    // Generate a unique visit ID for this specific visit
    const visitId = uuidv4();
    const timestamp = new Date().toISOString();
    
    // Parse the data payload
    let parsedData = {};
    if (data) {
      try {
        if (typeof data === 'string') {
          parsedData = JSON.parse(data);
        } else {
          parsedData = data;
        }
      } catch (e) {
        console.log('Error parsing data:', e);
        parsedData = data;
      }
    }

    // Calculate estimated points based on ticket type and number of people
    let estimatedPoints = 0;
    if (parsedData) {
      const numPeople = parseInt(parsedData.numPeople) || 1;
      const ticketType = (parsedData.ticket || 'Standard').toLowerCase();
      
      // Calculate base points based on ticket type
      switch (ticketType) {
        case 'vip':
          estimatedPoints = 50 * numPeople;
          break;
        case 'family':
          estimatedPoints = 30 * numPeople;
          break;
        case 'group':
          estimatedPoints = 20 * numPeople;
          break;
        case 'adult':
          estimatedPoints = 11; // Based on existing data
          break;
        default:
          estimatedPoints = 10 * numPeople;
      }
      
      // Add transport bonus
      if (parsedData.Transport === 'Yes' || parsedData.Bus_Rental || parsedData.selectedBus) {
        estimatedPoints += 5;
      }
      
      // Alternative: Use total price if available
      if (parsedData.totalPrice) {
        const priceBasedPoints = Math.floor(parseFloat(parsedData.totalPrice) / 100);
        estimatedPoints = Math.max(estimatedPoints, priceBasedPoints);
      }
    }

    // Store the main QR record with visit ID as part of the key
    const mainQrKey = `qr:${normalizedEmail}:${normalizedPartnerId}:${visitId}`;
    
    const qrRecord = {
      visitId,
      email: normalizedEmail,
      partnerId: normalizedPartnerId,
      payload: JSON.stringify({
        ...parsedData,
        estimatedPoints
      }),
      status: 'pending',
      visited: 'false',
      visitedAt: null,
      pointsAwarded: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    
    await kv.hmset(mainQrKey, qrRecord);
    
    // Also maintain a simpler key for backward compatibility
    const compatKey = `qr:email:${normalizedEmail}`;
    const existingCompat = await kv.hgetall(compatKey);
    
    // Only update compat key if it's empty or for a different partner
    if (!existingCompat || !existingCompat.partnerId || 
        existingCompat.partnerId.toLowerCase() !== normalizedPartnerId) {
      await kv.hmset(compatKey, qrRecord);
    }
    
    // Add to user's visit list
    const userVisitsKey = `user:visits:${normalizedEmail}`;
    await kv.sadd(userVisitsKey, mainQrKey);
    
    // Add to partner's visit list
    const partnerVisitsKey = `partner:visits:${normalizedPartnerId}`;
    await kv.sadd(partnerVisitsKey, mainQrKey);
    
    // Add user to partner's member list (for partner-specific operations)
    await kv.sadd(`partner:${normalizedPartnerId}`, normalizedEmail);
    await kv.sadd(`partner:${normalizedPartnerId.toUpperCase()}`, normalizedEmail);
    
    // Track visit metadata
    const visitMetaKey = `visit:meta:${visitId}`;
    await kv.hmset(visitMetaKey, {
      visitId,
      email: normalizedEmail,
      partnerId: normalizedPartnerId,
      qrKey: mainQrKey,
      status: 'pending',
      createdAt: timestamp,
      estimatedPoints
    });
    
    // Add visit to chronological list
    const chronoKey = `visits:chrono:${normalizedEmail}`;
    await kv.lpush(chronoKey, JSON.stringify({
      visitId,
      partnerId: normalizedPartnerId,
      qrKey: mainQrKey,
      createdAt: timestamp,
      estimatedPoints
    }));
    
    // Limit chronological list to last 100 visits
    await kv.ltrim(chronoKey, 0, 99);
    
    console.log('QR Registration successful:', {
      visitId,
      email: normalizedEmail,
      partnerId: normalizedPartnerId,
      qrKey: mainQrKey,
      estimatedPoints
    });
    
    // Return success response
    return respond(res, 200, {
      success: true,
      message: 'QR code registered successfully',
      data: {
        visitId,
        email: normalizedEmail,
        partnerId: normalizedPartnerId,
        estimatedPoints,
        status: 'pending',
        createdAt: timestamp
      }
    });

  } catch (error) {
    console.error('Error registering QR:', error);
    return respond(res, 500, {
      error: 'Internal server error',
      message: 'Failed to register QR code',
      details: error.message
    });
  }
}