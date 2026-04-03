/**
 * Background job to embed activities without embeddings
 */

import { surrealDB } from '../db/surreal';
import {
  getEmbeddingProvider,
  embedActivity,
} from '../services/embedding-service';
import { logger } from '../utils/logger';

export async function embedUnembeddedActivities(
  batchSize = 10
): Promise<number> {
  const provider = getEmbeddingProvider();
  if (!provider) {
    logger.warn('Embedding provider not configured, skipping embed job');
    return 0;
  }

  // Find activities without embeddings
  // Note: surrealDB.query<T> returns T[] (an array of T), so we don't wrap in array
  const activities = await surrealDB.query<{
    id: string;
    name: string;
    description?: string;
  }>(
    `
    SELECT id, name, description FROM activity
    WHERE embedding IS NONE
    LIMIT $limit
  `,
    { limit: batchSize }
  );

  if (!activities || activities.length === 0) {
    logger.debug('No activities to embed');
    return 0;
  }

  let embedded = 0;
  for (const activity of activities) {
    const embedding = await embedActivity(activity.name, activity.description);
    if (embedding) {
      await surrealDB.query(
        `
        UPDATE $id SET
          embedding = $embedding,
          embedding_model = $model,
          embedding_generated_at = time::now()
      `,
        {
          id: activity.id,
          embedding,
          model: provider.name,
        }
      );
      embedded++;
    }
  }

  logger.info('Embedded activities', { embedded, total: activities.length });
  return embedded;
}

/**
 * Start the embedding job as a periodic task
 * Runs every 5 minutes to embed any new activities
 */
export function startEmbedJob(intervalMs = 300_000): NodeJS.Timeout {
  const provider = getEmbeddingProvider();
  if (!provider) {
    logger.info(
      'Embedding provider not configured, embedding job will not start'
    );
    // Return a dummy interval that does nothing
    return setInterval(() => {}, intervalMs);
  }

  logger.info('Starting activity embedding job', {
    intervalMs,
    provider: provider.name,
  });

  // Run immediately on start
  embedUnembeddedActivities(50).catch((err) => {
    logger.error('Initial embed job failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Then run periodically
  return setInterval(async () => {
    try {
      await embedUnembeddedActivities(50);
    } catch (err) {
      logger.error('Embed job failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, intervalMs);
}

// Run as standalone script
if (import.meta.main) {
  embedUnembeddedActivities(50)
    .then((count) => {
      console.log(`Embedded ${count} activities`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Embed job failed:', err);
      process.exit(1);
    });
}
