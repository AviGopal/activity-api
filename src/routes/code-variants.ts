/**
 * Code Variants Routes — DEPRECATED (Phase B3b dead-code cleanup, 2026-04-28)
 *
 * Both handlers used to JOIN `activity_templates` (a phantom table — the real
 * one is `activity_template`, no `s`) against `variant_performance_metrics`,
 * so the queries always returned empty. The activity-dashboard's
 * `apiClient.listCodeVariants()` calls these endpoints, which is why the
 * mounts are kept (a 404 would surface as a generic dashboard error). A 410
 * Gone is the honest signal: the endpoint exists, the contract is gone.
 *
 * Replacement: variant performance is exposed via
 * `GET /v2/activities/:id/variant-scores` (Thompson Sampling family lookup).
 */

import { Hono } from 'hono';
import { logger } from '../utils/logger';

const app = new Hono();

const GONE_BODY = {
  error: 'endpoint_deprecated',
  message: 'Code-variants endpoints are deprecated; the backing JOIN targeted a phantom table.',
  replacement: 'GET /v2/activities/:id/variant-scores',
  deprecated_since: '2026-04-28',
};

app.get('/', (c) => {
  logger.warn('[code-variants] Deprecated endpoint called', { path: c.req.path });
  return c.json(GONE_BODY, 410);
});

app.get('/:variantId', (c) => {
  logger.warn('[code-variants] Deprecated endpoint called', { path: c.req.path });
  return c.json(GONE_BODY, 410);
});

export default app;
