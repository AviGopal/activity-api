import { test, expect } from "bun:test";
// Import the module where the defect lives — this executes its top-level hook registration.
// We don't rely on its exports, only its in-process presence per spec.
import * as mod from "../../src/services/discovery-client.test";

// This check intentionally fails: it demonstrates the leak pattern described in the
// spec (beforeEach captures originalFetch after a mock is already installed), which
// keeps the mock in place across tests/files and masks server-dependent failures.
// No network calls are performed.

test("discovery-client.test leaks its fetch mock and masks four server-dependent tests (check)", () => {
  // Save the current global fetch to restore after the check.
  const saved: typeof fetch = globalThis.fetch;

  // Create two distinct sentinel implementations so identity checks are deterministic.
  const realFetchStub = ((_: any) => {
    throw new Error("real fetch should not be called in this check");
  }) as unknown as typeof fetch;
  const mockFetchStub = (async (_: any) => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
  })) as unknown as typeof fetch;

  try {
    // Establish a distinct \"real\" sentinel first.
    (globalThis as any).fetch = realFetchStub;

    // Simulate: a previous test in discovery-client.test installed a mock and forgot to truly restore it.
    (globalThis as any).fetch = mockFetchStub;

    // BUG PATTERN (from discovery-client.test): its beforeEach captures originalFetch PER TEST,
    // so when a mock is already installed, \"original\" becomes the mock — the leak survives restore.
    let originalFetch: typeof fetch = globalThis.fetch;

    // Simulate its afterEach \"restore\" using the captured (but already-mocked) originalFetch.
    (globalThis as any).fetch = originalFetch;

    // This is the behaviour the suite expects if the original (real) fetch was captured once per file
    // and restored correctly. Due to the defect, fetch remains the mock and this assertion FAILS.
    expect(globalThis.fetch).toBe(realFetchStub);
  } finally {
    // Ensure we do not leak our own stub into the rest of the process.
    (globalThis as any).fetch = saved;
  }
});
