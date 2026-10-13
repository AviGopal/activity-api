import { test, expect, describe, beforeEach } from "bun:test";
import { mock } from "bun";
import * as PosteriorUpdate from "../../src/lib/posterior-update";
import { createHash } from "crypto";

function makeHashId(s: string) {
  return createHash('sha256').update(s).digest('hex').slice(0, 24);
}

describe("propagateCreditAlongChain environmental error handling", () => {
  let mockDb: PosteriorUpdate.DBQueryable;
  let dbCalls: any[] = [];

  beforeEach(() => {
    dbCalls = [];
    mockDb = {
      query: async (sql, params) => {
        dbCalls.push({ sql, params });
        return [];
      },
    };
  });

  test("environmental error at leaf abstains beta propagation to ancestors", async () => {
    const rootExecutionId = makeHashId("root");
    const parentExecutionId = makeHashId("parent");
    const leafExecutionId = makeHashId("leaf");

    const execution: PosteriorUpdate.ExecutionForChainCredit = {
      activity_id: "activity:123",
      activity_type: "manual",
      // Simulating an environmental execution error at the leaf
      outcome: {
        class: "execution_error",
        sub_class: "environmental",
        message: "Network timeout",
      },
      execution_id: leafExecutionId,
      trace_id: "trace:abc",
      parent_execution_id: parentExecutionId,
      ancestor_execution_ids: [
        { execution_id: rootExecutionId, activity_id: "activity:root" },
        { execution_id: parentExecutionId, activity_id: "activity:parent" },
      ],
      produced_shapes: [],
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      duration_ms: 100,
      decision_id: "decision:xyz",
      selected_activity_id: "activity:123",
      selection_duration_ms: 10,
      revision: 1,
      client_id: "client:test",
      version: 1
    };

    const orgId = "org:test";

    await PosteriorUpdate.propagateCreditAlongChain(execution, mockDb, orgId);

    // Expect no UPDATE operations for any ancestor's beta or alpha when the leaf is an environmental error
    const updateCalls = dbCalls.filter((call) =>
      call.sql.includes("UPDATE ONLY") && (call.sql.includes("beta = ") || call.sql.includes("alpha = "))
    );

    expect(updateCalls.length).toBe(0);
  });

  test("cascading environmental error still propagates to ancestors", async () => {
    const rootExecutionId = makeHashId("root");
    const parentExecutionId = makeHashId("parent");
    const leafExecutionId = makeHashId("leaf");

    const execution: PosteriorUpdate.ExecutionForChainCredit = {
      activity_id: "activity:123",
      activity_type: "manual",
      outcome: {
        class: "execution_error",
        sub_class: "cascading", // This should propagate decay
        message: "Upstream service failed",
      },
      execution_id: leafExecutionId,
      trace_id: "trace:abc",
      parent_execution_id: parentExecutionId,
      ancestor_execution_ids: [
        { execution_id: rootExecutionId, activity_id: "activity:root" },
        { execution_id: parentExecutionId, activity_id: "activity:parent" },
      ],
      produced_shapes: [],
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      duration_ms: 100,
      decision_id: "decision:xyz",
      selected_activity_id: "activity:123",
      selection_duration_ms: 10,
      revision: 1,
      client_id: "client:test",
      version: 1
    };

    const orgId = "org:test";

    await PosteriorUpdate.propagateCreditAlongChain(execution, mockDb, orgId);

    // Expect UPDATE operations for ancestors for 'cascading' sub_class
    const updateCalls = dbCalls.filter((call) =>
      call.sql.includes("UPDATE ONLY") && (call.sql.includes("beta = ") || call.sql.includes("alpha = "))
    );

    expect(updateCalls.length).toBeGreaterThan(0);
    expect(updateCalls.some(call => call.params.id === parentExecutionId)).toBeTrue();
    expect(updateCalls.some(call => call.params.id === rootExecutionId)).toBeTrue();
  });
});
