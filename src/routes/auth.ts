/**
 * Authentication Routes
 *
 * VESSEL ALIGNMENT (2026-04-02):
 * MiniBob authentication has been moved to identity-vessel.
 * Activity-API no longer issues tokens - it only validates them via JWT middleware.
 *
 * MiniBob instances should authenticate via:
 *   POST https://identity.metabob.local/v1/auth/minibob/signin
 *
 * Then use the returned JWT for activity-api calls with Authorization header.
 *
 * JWT validation is handled by:
 * - src/middleware/jwtAuth.ts (HTTP requests)
 * - src/services/auth.ts validateJwtToken() (WebSocket)
 */

import { Hono } from 'hono'

const auth = new Hono()

// No routes - authentication is handled by identity-vessel
// This file is kept for:
// 1. Documentation of the vessel alignment decision
// 2. The /v2/auth path prefix check in index.ts middleware

export default auth
