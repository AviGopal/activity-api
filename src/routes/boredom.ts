/**
 * Boredom Task Queue Routes
 *
 * Manages autonomous task queue for idle MiniBob vessels.
 * Uses Redis for queue storage with priority ordering.
 */

import { Hono } from "hono"
import Redis from "ioredis"

const app = new Hono()

// =============================================================================
// TYPES
// =============================================================================

export interface BoredomTask {
  id: string
  goal?: string          // Goal-based execution (preferred)
  templateId?: string    // Template-based execution (legacy)
  priority: "critical" | "high" | "medium" | "low"
  variables: Record<string, unknown>
  reason?: string
  createdAt: number
  assignedTo?: string
}

interface EnqueueRequest {
  goal?: string           // Goal-based execution (preferred)
  templateId?: string     // Template-based execution (legacy)
  priority?: "critical" | "high" | "medium" | "low"
  variables?: Record<string, unknown>
  reason?: string
}

// =============================================================================
// REDIS CLIENT
// =============================================================================

let redisClient: Redis | null = null

function getRedisClient(): Redis {
  if (!redisClient) {
    const redisUrl = process.env.REDIS_URL || "redis://redis-valkey.activity-system.svc.cluster.local:6379"
    redisClient = new Redis(redisUrl)

    redisClient.on("error", (err) => {
      console.error("[Boredom] Redis error:", err)
    })

    console.log("[Boredom] Redis client connected")
  }

  return redisClient
}

// =============================================================================
// QUEUE OPERATIONS
// =============================================================================

const QUEUE_KEY_PREFIX = "boredom:queue:"
const PRIORITY_SCORES = {
  critical: 1000,
  high: 100,
  medium: 10,
  low: 1
}

/**
 * Add task to boredom queue
 * Exported for use by TaskGenerator service
 */
export async function enqueueTask(task: BoredomTask): Promise<void> {
  const redis = getRedisClient()

  // Store task data
  const taskKey = `boredom:task:${task.id}`
  await redis.setex(taskKey, 86400, JSON.stringify(task)) // Expire after 24 hours

  // Add to priority queue (sorted set)
  const queueKey = `${QUEUE_KEY_PREFIX}${task.priority}`
  const score = Date.now() // FIFO within priority level
  await redis.zadd(queueKey, score, task.id)

  console.log(`[Boredom] Enqueued task ${task.id} with priority ${task.priority}`)
}

/**
 * Fetch highest priority task from queue
 */
async function fetchTask(): Promise<BoredomTask | null> {
  const redis = getRedisClient()

  // Try each priority level from highest to lowest
  for (const priority of ["critical", "high", "medium", "low"] as const) {
    const queueKey = `${QUEUE_KEY_PREFIX}${priority}`

    // Get oldest task at this priority
    const taskIds = await redis.zrange(queueKey, 0, 0)

    if (taskIds.length > 0) {
      const taskId = taskIds[0]
      if (!taskId) continue

      // Get task data
      const taskKey = `boredom:task:${taskId}`
      const taskJson = await redis.get(taskKey)

      if (!taskJson) {
        // Task expired, remove from queue
        await redis.zrem(queueKey, taskId)
        continue
      }

      // Remove from queue (task is now assigned)
      await redis.zrem(queueKey, taskId)

      const task = JSON.parse(taskJson) as BoredomTask
      console.log(`[Boredom] Fetched task ${taskId} (priority: ${priority})`)

      return task
    }
  }

  return null
}

/**
 * Get queue statistics
 */
async function getQueueStats(): Promise<Record<string, number>> {
  const redis = getRedisClient()

  const stats: Record<string, number> = {}

  for (const priority of ["critical", "high", "medium", "low"]) {
    const queueKey = `${QUEUE_KEY_PREFIX}${priority}`
    const count = await redis.zcard(queueKey)
    stats[priority] = count
  }

  return stats
}

// =============================================================================
// ROUTES
// =============================================================================

/**
 * GET /boredom-tasks - Fetch next task (legacy endpoint)
 */
app.get("/boredom-tasks", async (c) => {
  try {
    const task = await fetchTask()

    if (!task) {
      return c.json({ tasks: [] })
    }

    return c.json({ tasks: [task] })
  } catch (error) {
    console.error("[Boredom] Error fetching tasks:", error)
    return c.json({ error: "Failed to fetch tasks", tasks: [] }, 500)
  }
})

/**
 * POST /v2/activities/boredom/enqueue - Add task to queue
 */
app.post("/v2/activities/boredom/enqueue", async (c) => {
  try {
    const body = await c.req.json() as EnqueueRequest

    // Require either goal or templateId
    if (!body.goal && !body.templateId) {
      return c.json({ error: "Either 'goal' or 'templateId' is required" }, 400)
    }

    const task: BoredomTask = {
      id: `boredom_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      goal: body.goal,
      templateId: body.templateId,
      priority: body.priority || "medium",
      variables: body.variables || {},
      reason: body.reason,
      createdAt: Date.now()
    }

    await enqueueTask(task)

    console.log(`[Boredom] Enqueued ${body.goal ? 'goal' : 'template'}-based task: ${task.id}`)

    return c.json({
      success: true,
      taskId: task.id,
      type: body.goal ? 'goal' : 'template'
    })
  } catch (error) {
    console.error("[Boredom] Error enqueuing task:", error)
    return c.json({ error: "Failed to enqueue task" }, 500)
  }
})

/**
 * GET /v2/activities/boredom/queue - Get queue statistics
 */
app.get("/v2/activities/boredom/queue", async (c) => {
  try {
    const stats = await getQueueStats()
    const total = Object.values(stats).reduce((sum, count) => sum + count, 0)

    return c.json({
      total,
      byPriority: stats
    })
  } catch (error) {
    console.error("[Boredom] Error getting queue stats:", error)
    return c.json({ error: "Failed to get queue stats" }, 500)
  }
})

/**
 * POST /boredom-tasks/:taskId/result - Report task completion (MiniBob format)
 */
app.post("/boredom-tasks/:taskId/result", async (c) => {
  try {
    const taskId = c.req.param("taskId")
    const body = await c.req.json() as {
      success: boolean
      executionId?: string
      durationMs?: number
      error?: string
    }

    const redis = getRedisClient()

    // Get original task data
    const taskKey = `boredom:task:${taskId}`
    const taskJson = await redis.get(taskKey)

    if (!taskJson) {
      console.log(`[Boredom] Task ${taskId} not found (may have expired)`)
      return c.json({ success: true, message: "Task not found but result accepted" })
    }

    const task = JSON.parse(taskJson) as BoredomTask

    // Store result for analytics
    const resultKey = `boredom:result:${taskId}`
    await redis.setex(resultKey, 86400 * 7, JSON.stringify({
      taskId: taskId,
      templateId: task.templateId,
      success: body.success,
      executionId: body.executionId,
      durationMs: body.durationMs,
      error: body.error,
      completedAt: Date.now()
    }))

    // Delete task data (completed)
    await redis.del(taskKey)

    console.log(`[Boredom] Task ${taskId} completed: ${body.success ? "success" : "failed"}`)

    return c.json({
      success: true,
      message: `Result recorded for task ${taskId}`
    })
  } catch (error) {
    console.error("[Boredom] Error recording result:", error)
    return c.json({ error: "Failed to record result" }, 500)
  }
})

/**
 * POST /v2/activities/boredom/results - Report task completion
 */
app.post("/v2/activities/boredom/results", async (c) => {
  try {
    const body = await c.req.json() as {
      taskId: string
      success: boolean
      executionId?: string
      durationMs?: number
      error?: string
    }

    if (!body.taskId) {
      return c.json({ error: "taskId required" }, 400)
    }

    const redis = getRedisClient()

    // Get original task data
    const taskKey = `boredom:task:${body.taskId}`
    const taskJson = await redis.get(taskKey)

    if (!taskJson) {
      console.log(`[Boredom] Task ${body.taskId} not found (may have expired)`)
      return c.json({ success: true, message: "Task not found but result accepted" })
    }

    const task = JSON.parse(taskJson) as BoredomTask

    // Store result for analytics
    const resultKey = `boredom:result:${body.taskId}`
    await redis.setex(resultKey, 86400 * 7, JSON.stringify({
      taskId: body.taskId,
      templateId: task.templateId,
      success: body.success,
      executionId: body.executionId,
      durationMs: body.durationMs,
      error: body.error,
      completedAt: Date.now()
    }))

    // Delete task data (completed)
    await redis.del(taskKey)

    console.log(`[Boredom] Task ${body.taskId} completed: ${body.success ? "success" : "failed"}`)

    return c.json({
      success: true,
      message: `Result recorded for task ${body.taskId}`
    })
  } catch (error) {
    console.error("[Boredom] Error recording result:", error)
    return c.json({ error: "Failed to record result" }, 500)
  }
})

/**
 * GET /v2/activities/boredom/results - Get recent task results
 */
app.get("/v2/activities/boredom/results", async (c) => {
  try {
    const redis = getRedisClient()
    const limit = parseInt(c.req.query("limit") || "50")

    // Get all result keys
    const keys = await redis.keys("boredom:result:*")

    const results: any[] = []
    for (const key of keys.slice(0, limit)) {
      const resultJson = await redis.get(key)
      if (resultJson) {
        results.push(JSON.parse(resultJson))
      }
    }

    // Sort by completedAt descending
    results.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))

    return c.json({
      results,
      total: results.length
    })
  } catch (error) {
    console.error("[Boredom] Error getting results:", error)
    return c.json({ error: "Failed to get results" }, 500)
  }
})

/**
 * POST /v2/vessels/register - Register vessel capabilities
 */
app.post("/v2/vessels/register", async (c) => {
  try {
    const body = await c.req.json() as {
      id: string
      name: string
      version: string
      capabilities: string[]
      tools: string[]
      metadata?: Record<string, unknown>
    }

    // For now, just log registration
    // Could store in Redis or SurrealDB for capability routing
    console.log(`[Vessels] Registered vessel: ${body.id} with capabilities: ${body.capabilities.join(", ")}`)

    return c.json({
      success: true,
      message: `Vessel ${body.id} registered successfully`
    })
  } catch (error) {
    console.error("[Vessels] Error registering vessel:", error)
    return c.json({ error: "Failed to register vessel" }, 500)
  }
})

/**
 * POST /v2/activities/boredom/generate - Generate self-development tasks
 *
 * Analyzes execution metrics and generates improvement opportunities.
 * Can be called manually or by scheduled job.
 */
app.post("/v2/activities/boredom/generate", async (c) => {
  try {
    // Dynamic import to avoid circular dependency
    const { taskGenerator } = await import('../services/task-generator')

    const opportunities = await taskGenerator.detectOpportunities()

    // Enqueue all generated tasks
    const enqueued: string[] = []
    for (const task of opportunities) {
      try {
        await enqueueTask(task)
        enqueued.push(task.id)
      } catch (e) {
        console.error(`[Boredom] Failed to enqueue task ${task.id}:`, e)
      }
    }

    const stats = await getQueueStats()

    return c.json({
      success: true,
      generated: opportunities.length,
      enqueued: enqueued.length,
      tasks: opportunities.map(t => ({
        id: t.id,
        templateId: t.templateId,
        priority: t.priority,
        reason: t.reason,
      })),
      queueStats: stats,
    })
  } catch (error) {
    console.error("[Boredom] Error generating tasks:", error)
    return c.json({ error: "Failed to generate tasks" }, 500)
  }
})

/**
 * GET /v2/activities/boredom/stats - Get comprehensive queue statistics
 */
app.get("/v2/activities/boredom/stats", async (c) => {
  try {
    const { taskGenerator } = await import('../services/task-generator')

    const queueStats = await getQueueStats()
    const generatorStats = await taskGenerator.getQueueStats()

    return c.json({
      queue: queueStats,
      templatesNeedingAttention: generatorStats.templatesNeedingAttention,
      totalPending: Object.values(queueStats).reduce((a, b) => a + b, 0),
    })
  } catch (error) {
    console.error("[Boredom] Error getting stats:", error)
    return c.json({ error: "Failed to get stats" }, 500)
  }
})

export default app
