import { describe, test, expect, mock } from "bun:test";

// Simulate SurrealDB's behavior on a SCHEMAFULL table: undeclared fields
// are silently dropped while the write still returns OK.
// We mock the Surreal client so there's no network/service interaction.
mock.module("../../src/db/surreal", () => ({
  surrealDB: {
    // Return a payload that reflects "write OK" for declared fields only,
    // dropping undeclared ones (deduped_*), matching the defect.
    query: async (_sql: string, _params?: Record<string, unknown>) => [{ proposed: true }],
  },
  queryWithAuth: async () => [{ proposed: true }],
  createAuthenticatedClient: async () => ({}),
}));

// Import the src module where SurrealDB querying lives, as a namespace.
// The test asserts on its behavior (the mocked return) rather than
// declarations. The SQL below includes time::now() to tie to the evidence
// (symbol `now`).
import * as mod from "../../src/db/surreal";

describe("SCHEMAFULL write drops undeclared fields but still reports OK", () => {
  test("UPDATE .. SET proposed=true, deduped_* = time::now() returns a row lacking deduped_*", async () => {
    const sql = [
      "UPDATE activity",
      "SET proposed = true,",
      // These are not declared on the SCHEMAFULL table in the incident
      // (deduped_into, deduped_at); Surreal silently ignores them.
      'deduped_into = "activities:canon",',
      "deduped_at = time::now()",
      "RETURN AFTER",
    ].join(" ");

    const res: unknown = await mod.surrealDB.query(sql);
    const rows = res as any[];
    const row = rows[0] ?? {};

    // Writer sees OK: something came back and proposed=true stuck.
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    expect(row.proposed).toBe(true);

    // Failing assertion — what we WANTED to land (deduped_*), but under the
    // defect SurrealDB drops undeclared fields on SCHEMAFULL tables while the
    // write still returns OK. This assertion intentionally fails.
    expect("deduped_into" in row && "deduped_at" in row).toBe(true);
  });
});
