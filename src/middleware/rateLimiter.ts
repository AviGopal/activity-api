/**
 * Rate Limiter Middleware
 *
 * Simple in-memory rate limiter for auth endpoints.
 * Prevents brute force attacks on API key and credential authentication.
 */

import type { Context, Next } from 'hono';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// In-memory store for rate limit tracking
// Key: IP address or identifier
const rateLimitStore = new Map<string, RateLimitEntry>();

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.resetAt < now) {
      rateLimitStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

export interface RateLimiterConfig {
  /** Maximum requests per window */
  maxRequests: number;
  /** Window size in milliseconds */
  windowMs: number;
  /** Custom key extractor (default: IP address) */
  keyExtractor?: (c: Context) => string;
}

/**
 * Create rate limiter middleware
 */
export function createRateLimiter(config: RateLimiterConfig) {
  const { maxRequests, windowMs, keyExtractor } = config;

  return async (c: Context, next: Next) => {
    // Get the key (IP address by default)
    const key = keyExtractor
      ? keyExtractor(c)
      : c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
        c.req.header('x-real-ip') ||
        'unknown';

    const now = Date.now();
    const entry = rateLimitStore.get(key);

    if (!entry || entry.resetAt < now) {
      // First request or window expired - create new entry
      rateLimitStore.set(key, {
        count: 1,
        resetAt: now + windowMs,
      });
      await next();
      return;
    }

    // Check if over limit
    if (entry.count >= maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);

      return c.json({
        error: 'rate_limit_exceeded',
        message: `Too many requests. Try again in ${retryAfter} seconds.`,
        retry_after: retryAfter,
      }, 429, {
        'Retry-After': String(retryAfter),
        'X-RateLimit-Limit': String(maxRequests),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.ceil(entry.resetAt / 1000)),
      });
    }

    // Increment count and continue
    entry.count++;

    // Add rate limit headers to response
    c.header('X-RateLimit-Limit', String(maxRequests));
    c.header('X-RateLimit-Remaining', String(maxRequests - entry.count));
    c.header('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    await next();
  };
}

/**
 * Pre-configured rate limiter for auth endpoints
 *
 * Limits: 10 requests per minute per IP
 * This prevents brute force attacks while allowing legitimate retries
 */
export const authRateLimiter = createRateLimiter({
  maxRequests: 10,
  windowMs: 60 * 1000, // 1 minute
});

/**
 * Stricter rate limiter for signin endpoints
 *
 * Limits: 5 requests per minute per IP
 * More restrictive for actual authentication attempts
 */
export const signinRateLimiter = createRateLimiter({
  maxRequests: 5,
  windowMs: 60 * 1000, // 1 minute
});
