/**
 * Phase A: ACCOUNT_ID_REQUIRED feature flag default + override behavior.
 *
 * OpenSpec change: activity-api-account-id-migration-2026-04-28
 *
 * The flag defaults to false during Phase A so legacy callers without
 * an `account_id` JWT claim continue to work. Operators flip it to true
 * (via the env var) once Phase F backfill completes, at which point
 * Phase D handlers reject requests missing the claim.
 *
 * This test exercises `loadConfig()` directly (rather than the cached
 * `config` const) so we can probe both default and overridden behavior
 * without polluting the singleton across test files.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { loadConfig } from './config';

describe('Phase A: ACCOUNT_ID_REQUIRED feature flag', () => {
  // Snapshot original env so we can restore between tests; the suite
  // mutates process.env to simulate operator overrides.
  const originalAccountIdRequired = process.env.ACCOUNT_ID_REQUIRED;
  // SURREALDB_NAMESPACE is required by validateNamespace(); set a dev
  // sentinel so loadConfig() doesn't throw in the unit-test sandbox.
  const originalNamespace = process.env.SURREALDB_NAMESPACE;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.SURREALDB_NAMESPACE ??= 'activity-system';
    // Force non-production so resolveJwtSecret() takes the dev sentinel
    // path instead of throwing.
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    if (originalAccountIdRequired === undefined) {
      delete process.env.ACCOUNT_ID_REQUIRED;
    } else {
      process.env.ACCOUNT_ID_REQUIRED = originalAccountIdRequired;
    }
    if (originalNamespace === undefined) {
      delete process.env.SURREALDB_NAMESPACE;
    } else {
      process.env.SURREALDB_NAMESPACE = originalNamespace;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  test('defaults to false when ACCOUNT_ID_REQUIRED is unset', () => {
    delete process.env.ACCOUNT_ID_REQUIRED;
    const cfg = loadConfig();
    expect(cfg.auth.accountIdRequired).toBe(false);
  });

  test('honors ACCOUNT_ID_REQUIRED=true (string) override', () => {
    process.env.ACCOUNT_ID_REQUIRED = 'true';
    const cfg = loadConfig();
    expect(cfg.auth.accountIdRequired).toBe(true);
  });

  test('honors ACCOUNT_ID_REQUIRED=1 (numeric form) override', () => {
    process.env.ACCOUNT_ID_REQUIRED = '1';
    const cfg = loadConfig();
    expect(cfg.auth.accountIdRequired).toBe(true);
  });

  test('treats ACCOUNT_ID_REQUIRED=false as false (Phase A canonical)', () => {
    process.env.ACCOUNT_ID_REQUIRED = 'false';
    const cfg = loadConfig();
    expect(cfg.auth.accountIdRequired).toBe(false);
  });

  test('treats arbitrary non-truthy values as false (defensive)', () => {
    process.env.ACCOUNT_ID_REQUIRED = 'maybe';
    const cfg = loadConfig();
    expect(cfg.auth.accountIdRequired).toBe(false);
  });
});
