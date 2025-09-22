import { kv } from '@vercel/kv';
import { respond, setCors } from '../../../lib/utils.js';
import { z } from 'zod';

// Validation schemas
const createRewardSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().min(1, 'Description is required'),
  pointsCost: z.number().min(1, 'Points cost must be at least 1'),
  category: z.enum(['discount', 'freebie', 'experience', 'merchandise', 'other']),
  availableFor: z.array(z.string()).optional(), // Partner IDs
  stock: z.number().optional(),
  imageUrl: z.string().url().optional(),
  redemptionInstructions: z.string().optional(),
  validUntil: z.string().optional()
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
  if (adminSecret !== process.env.ADMIN_SECRET) {
    return respond(res, 401, { error: 'Unauthorized' });
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
  if (rewardId) {
    // Get single reward
    const reward = await kv.hgetall(`reward:${rewardId}`);
    if (!reward) {
      return respond(res, 404, { error: 'Reward not found' });
    }

    // Get redemption statistics
    const allRedemptions = await kv.keys('redemption:*');
    let redemptionCount = 0;
    let totalPointsSpent = 0;

    for (const key of allRedemptions) {
      const redemption = await kv.hgetall(key);
      if (redemption && redemption.rewardId === rewardId) {
        redemptionCount++;
        totalPointsSpent += parseInt(redemption.pointsSpent) || 0;
      }
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

  // Get all rewards
  const rewardIds = await kv.smembers('rewards') || [];
  const rewards = [];

  for (const id of rewardIds) {
    const reward = await kv.hgetall(`reward:${id}`);
    if (reward) {
      rewards.push({
        id,
        ...reward,
        availableFor: reward.availableFor ? JSON.parse(reward.availableFor) : [],
        pointsCost: parseInt(reward.pointsCost) || 0,
        stock: reward.stock ? parseInt(reward.stock) : null
      });
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
    await kv.hset(`reward:${rewardId}`, reward);
    await kv.sadd('rewards', rewardId);

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