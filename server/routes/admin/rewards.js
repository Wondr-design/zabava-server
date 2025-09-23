import { kv } from '@vercel/kv';
import { respond, setCors } from '../../../lib/utils.js';
import { z } from 'zod';

// Validation schemas
const createRewardSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional().default(''), // Allow empty description
  pointsCost: z.number().min(1, 'Points cost must be at least 1'),
  category: z.enum(['discount', 'freebie', 'experience', 'merchandise', 'other']),
  availableFor: z.array(z.string()).optional().default([]), // Partner IDs
  stock: z.number().optional(),
  imageUrl: z.string().optional().default(''), // Allow empty or non-URL for image
  redemptionInstructions: z.string().optional().default(''),
  validUntil: z.string().optional().default('')
});

const updateRewardSchema = createRewardSchema.partial();

/**
 * Admin rewards management endpoints
 * GET /api/admin/rewards - List all rewards
 * POST /api/admin/rewards - Create new reward
 * PUT /api/admin/rewards/:id - Update reward
 * DELETE /api/admin/rewards/:id - Delete reward
 */
export default async function handler(req, res) {
  setCors(res);
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Check admin authentication
  const adminSecret = req.headers['x-admin-secret'];
  const validSecret = process.env.ADMIN_SECRET || 'zabava';
  
  if (!adminSecret || adminSecret !== validSecret) {
    console.log('Admin auth failed:', { provided: adminSecret, expected: validSecret });
    return respond(res, 401, { error: 'Unauthorized - Invalid admin secret' });
  }

  try {
    // Extract reward ID from path if present
    const pathParts = req.url.split('/');
    const rewardId = pathParts.length > 4 ? pathParts[4] : null;

    switch (req.method) {
      case 'GET':
        return await handleGetRewards(req, res, rewardId);
      case 'POST':
        return await handleCreateReward(req, res);
      case 'PUT':
        return await handleUpdateReward(req, res, rewardId);
      case 'DELETE':
        return await handleDeleteReward(req, res, rewardId);
      default:
        return respond(res, 405, { error: 'Method Not Allowed' });
    }
  } catch (error) {
    console.error('Admin rewards error:', error);
    return respond(res, 500, { error: 'Internal server error' });
  }
}

async function handleGetRewards(req, res, rewardId) {
  try {
    if (rewardId) {
      // Get single reward
      const reward = await kv.hgetall(`reward:${rewardId}`);
      if (!reward) {
        return respond(res, 404, { error: 'Reward not found' });
      }

      // Get redemption statistics - wrapped in try-catch
      let redemptionCount = 0;
      let totalPointsSpent = 0;
      
      try {
        const allRedemptions = await kv.keys('redemption:*');
        if (allRedemptions && Array.isArray(allRedemptions)) {
          for (const key of allRedemptions) {
            const redemption = await kv.hgetall(key);
            if (redemption && redemption.rewardId === rewardId) {
              redemptionCount++;
              totalPointsSpent += parseInt(redemption.pointsSpent) || 0;
            }
          }
        }
      } catch (statsError) {
        console.error('Failed to fetch redemption statistics:', statsError);
        // Continue without statistics
      }

      return respond(res, 200, {
        ...reward,
        id: rewardId,
        availableFor: reward.availableFor ? JSON.parse(reward.availableFor) : [],
        statistics: {
          redemptions: redemptionCount,
          totalPointsSpent
        }
      });
    }

    // Get all rewards - always use keys pattern for reliability
    let rewardIds = [];
    
    try {
      // Try to get all reward keys directly
      const allKeys = await kv.keys('reward*');
      console.log('Found all reward keys:', allKeys);
      
      if (allKeys && Array.isArray(allKeys)) {
        // First try simple keys
        const simpleKeys = allKeys.filter(key => key.startsWith('reward_simple:'));
        if (simpleKeys.length > 0) {
          console.log('Found simple keys:', simpleKeys);
          rewardIds = simpleKeys.map(key => key.replace('reward_simple:', ''));
        } else {
          // Fall back to hash keys
          const hashKeys = allKeys.filter(key => {
            const parts = key.split(':');
            return parts.length === 2 && parts[0] === 'reward';
          });
          if (hashKeys.length > 0) {
            rewardIds = hashKeys.map(key => key.split(':')[1]);
          }
        }
        
        console.log('Extracted reward IDs:', rewardIds);
      }
    } catch (err) {
      console.error('Failed to fetch reward keys:', err);
      
      // Try the set as a fallback
      try {
        const setIds = await kv.smembers('rewards');
        if (setIds && setIds.length > 0) {
          rewardIds = setIds;
          console.log('Got IDs from set:', rewardIds);
        }
      } catch (setErr) {
        console.error('Failed to fetch from set:', setErr);
      }
    }
    
    const rewards = [];

    for (const id of rewardIds) {
      try {
        // First try to get from simple storage
        let reward = null;
        let isSimple = false;
        
        try {
          const simpleData = await kv.get(`reward_simple:${id}`);
          if (simpleData) {
            reward = typeof simpleData === 'string' ? JSON.parse(simpleData) : simpleData;
            isSimple = true;
            console.log(`Got reward ${id} from simple storage`);
          }
        } catch (simpleErr) {
          console.log(`No simple data for ${id}`);
        }
        
        // If not found in simple, try hash
        if (!reward) {
          reward = await kv.hgetall(`reward:${id}`);
          console.log(`Got reward ${id} from hash storage`);
        }
        
        if (reward && (reward.name || reward.id)) { // Check if reward has data
          if (isSimple) {
            // Simple format already has the right structure
            rewards.push(reward);
          } else {
            // Hash format needs processing
            rewards.push({
              id,
              ...reward,
              availableFor: reward.availableFor ? JSON.parse(reward.availableFor) : [],
              pointsCost: parseInt(reward.pointsCost) || 0,
              stock: reward.stock ? parseInt(reward.stock) : null
            });
          }
        }
      } catch (err) {
        console.error(`Failed to fetch reward ${id}:`, err);
        // Skip this reward and continue
      }
    }

    // Get overall statistics
    const stats = {
      totalRewards: rewards.length,
      activeRewards: rewards.filter(r => r.status === 'active').length,
      categories: [...new Set(rewards.map(r => r.category))],
      totalStock: rewards.reduce((sum, r) => sum + (r.stock || 0), 0)
    };

    return respond(res, 200, {
      rewards: rewards.sort((a, b) => a.pointsCost - b.pointsCost),
      statistics: stats
    });
  } catch (error) {
    console.error('handleGetRewards error:', error);
    return respond(res, 500, { error: 'Failed to fetch rewards', details: error.message });
  }
}

async function handleCreateReward(req, res) {
  try {
    const validation = createRewardSchema.safeParse(req.body);
    
    if (!validation.success) {
      return respond(res, 400, {
        error: 'Validation failed',
        details: validation.error.flatten()
      });
    }

    const data = validation.data;
    const rewardId = `reward-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    const reward = {
      name: data.name,
      description: data.description,
      pointsCost: data.pointsCost,
      category: data.category,
      availableFor: JSON.stringify(data.availableFor || []),
      stock: data.stock || null,
      imageUrl: data.imageUrl || '',
      redemptionInstructions: data.redemptionInstructions || '',
      validUntil: data.validUntil || '',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Save reward
    console.log('Saving reward with ID:', rewardId);
    console.log('Reward data:', reward);
    
    // Try multiple approaches to ensure storage
    try {
      // Save the reward data
      await kv.hset(`reward:${rewardId}`, reward);
      console.log('Saved reward hash');
      
      // Add to the rewards set
      await kv.sadd('rewards', rewardId);
      console.log('Added to rewards set');
      
      // Also save a simple key-value pair as backup
      await kv.set(`reward_simple:${rewardId}`, JSON.stringify({
        id: rewardId,
        ...reward,
        availableFor: data.availableFor || []
      }));
      console.log('Saved simple backup');
    } catch (saveError) {
      console.error('Error saving reward:', saveError);
      throw saveError;
    }

    // If specific partners are selected, notify them
    if (data.availableFor && data.availableFor.length > 0) {
      for (const partnerId of data.availableFor) {
        await kv.sadd(`partner:rewards:${partnerId}`, rewardId);
      }
    }

    return respond(res, 201, {
      success: true,
      message: 'Reward created successfully',
      reward: {
        id: rewardId,
        ...reward,
        availableFor: data.availableFor || []
      }
    });

  } catch (error) {
    console.error('Create reward error:', error);
    return respond(res, 500, { error: 'Failed to create reward' });
  }
}

async function handleUpdateReward(req, res, rewardId) {
  if (!rewardId) {
    return respond(res, 400, { error: 'Reward ID is required' });
  }

  const existing = await kv.hgetall(`reward:${rewardId}`);
  if (!existing) {
    return respond(res, 404, { error: 'Reward not found' });
  }

  try {
    const validation = updateRewardSchema.safeParse(req.body);
    
    if (!validation.success) {
      return respond(res, 400, {
        error: 'Validation failed',
        details: validation.error.flatten()
      });
    }

    const updates = validation.data;
    
    // Prepare updated data
    const updatedReward = {
      ...existing,
      ...updates,
      availableFor: updates.availableFor ? JSON.stringify(updates.availableFor) : existing.availableFor,
      updatedAt: new Date().toISOString()
    };

    // Update reward
    await kv.hset(`reward:${rewardId}`, updatedReward);

    // Update partner associations if availableFor changed
    if (updates.availableFor) {
      const oldPartners = existing.availableFor ? JSON.parse(existing.availableFor) : [];
      const newPartners = updates.availableFor;

      // Remove from old partners
      for (const partnerId of oldPartners) {
        if (!newPartners.includes(partnerId)) {
          await kv.srem(`partner:rewards:${partnerId}`, rewardId);
        }
      }

      // Add to new partners
      for (const partnerId of newPartners) {
        if (!oldPartners.includes(partnerId)) {
          await kv.sadd(`partner:rewards:${partnerId}`, rewardId);
        }
      }
    }

    return respond(res, 200, {
      success: true,
      message: 'Reward updated successfully',
      reward: {
        id: rewardId,
        ...updatedReward,
        availableFor: updates.availableFor || JSON.parse(existing.availableFor || '[]')
      }
    });

  } catch (error) {
    console.error('Update reward error:', error);
    return respond(res, 500, { error: 'Failed to update reward' });
  }
}

async function handleDeleteReward(req, res, rewardId) {
  if (!rewardId) {
    return respond(res, 400, { error: 'Reward ID is required' });
  }

  const existing = await kv.hgetall(`reward:${rewardId}`);
  if (!existing) {
    return respond(res, 404, { error: 'Reward not found' });
  }

  // Soft delete - just mark as inactive
  await kv.hset(`reward:${rewardId}`, {
    ...existing,
    status: 'inactive',
    deletedAt: new Date().toISOString()
  });

  // Remove from partner associations
  const partners = existing.availableFor ? JSON.parse(existing.availableFor) : [];
  for (const partnerId of partners) {
    await kv.srem(`partner:rewards:${partnerId}`, rewardId);
  }

  return respond(res, 200, {
    success: true,
    message: 'Reward deleted successfully',
    rewardId
  });
}