/**
 * This check reproduces a failure scenario where the pull-sync test gate
 * accepted a degraded baseline for activity-api. The specific regression
 * was an increase in failing tests related to incomplete mock.module
 * factories, which this test simulates.
 *
 * It introduces an incomplete mock for the `config` module, omitting a
 * required property (`surrealdb.url`). It then calls a function from
 * `auth-session-pool` that relies on this missing property. The function
 * is expected to throw an error. The test asserts that the function
 * *resolves*, which will fail, thus demonstrating the regression.
 */
import { describe, test, expect, mock, afterEach } from 'bun:test';

// Mock the config module to be incomplete. Specifically, we're omitting
// the `url` property from the `surrealdb` config object.
// This simulates an "amputated" module export scenario.
mock.module('../../src/config.ts', () => {
  return {
    config: {
      surrealdb: {
        // url is intentionally omitted to cause a failure downstream.
        namespace: 'test-namespace',
        database: 'test-db',
        username: 'test-user',
        password: 'test-password',
        authEnabled: true,
      },
    },
  };
});

// We must import the module *after* the mock has been defined.
// This module depends on the `config` module we've just mocked.
import * as AuthPool from '../../src/db/auth-session-pool';

describe('pull-sync testgate baseline-degraded for activity-api', () => {
  afterEach(() => {
    // Reset the singleton's state to ensure test isolation.
    AuthPool.authSessionPool.__resetForTests();
  });

  test('fails to acquire db session due to incomplete mock', async () => {
    // The defect is that an incomplete mock can cause runtime errors in dependent code.
    // Here, authSessionPool.acquire will fail because the mocked config is missing
    // `surrealdb.url`, which is needed to establish a connection.
    const acquirePromise = AuthPool.authSessionPool.acquire(
      'fake-jwt',
      'test-ns',
      'test-db'
    );

    // This assertion is designed to FAIL. We expect `acquirePromise` to reject
    // because of the incomplete mock. By asserting that it resolves, we create a
    // failing test that reproduces the type of regression the gate should have caught.
    await expect(acquirePromise).resolves.toBeDefined();
  });
});
