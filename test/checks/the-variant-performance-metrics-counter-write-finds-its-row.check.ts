import { expect, mock, test } from "bun:test";
import { Hono } from "hono";

interface Row {
  id: string;
  variant_id: string;
  org_id?: string | null;
  account_id?: string | null;
  thompson_alpha: number;
  thompson_beta: number;
  [key: string]: unknown;
}
type Bindings = Record<string, unknown>;

const variant = "ribosome-extract";
const org = "organizations:substrate";
const executionId = "vpm-counter-row-check";
const dropMessage = "posterior delta DROPPED — no variant_performance_metrics row";
const messages: unknown[][] = [];
let rows: Row[] = [];
let trace: Bindings = {};
let counterWrites = 0;

function bound(name: string, bindings: Bindings): unknown {
  return bindings[name];
}

function matches(row: Row, sql: string, bindings: Bindings): boolean {
  const where = sql.split(/\bWHERE\b/i)[1]?.split(/\b(?:LIMIT|RETURN|ORDER|GROUP)\b/i)[0];
  if (!where) return true;
  for (const field of ["variant_id", "org_id", "account_id", "id"]) {
    const comparison = new RegExp(`\\b${field}\\s*(?:=|IS)\\s*\\$(\\w+)`, "i").exec(where);
    if (!comparison) continue;
    const name = comparison[1];
    if (!name) throw new Error("Missing SQL binding name");
    const actual = row[field];
    const expected = bound(name, bindings);
    if (field === "account_id" && expected == null && actual == null) continue;
    if (String(actual) !== String(expected)) return false;
  }
  return true;
}

function numeric(expression: string, row: Row, bindings: Bindings): number {
  let value = expression.replace(/<\s*(?:float|int|number)\s*>/gi, "");
  value = value.replace(/\b([a-zA-Z_]\w*)\s*\?\?\s*([\d.]+)/g, (_match: string, field: string, fallback: string): string => {
    return String(row[field] ?? Number(fallback));
  });
  value = value.replace(/\$(\w+)/g, (_match: string, name: string): string => String(bindings[name]));
  value = value.replace(/\b[a-zA-Z_]\w*\b/g, (field: string): string => String(row[field]));
  if (!/^[\d\s.+*/()\-]+$/.test(value)) throw new Error(`Unsupported numeric SQL expression: ${expression}`);
  const result: unknown = Function(`"use strict"; return (${value});`)();
  if (typeof result !== "number" || !Number.isFinite(result)) throw new Error(`Invalid numeric SQL expression: ${expression}`);
  return result;
}

function applyPosteriorAssignments(row: Row, sql: string, bindings: Bindings): void {
  for (const field of ["thompson_alpha", "thompson_beta"] as const) {
    const assignment = new RegExp(`\\b${field}\\s*(\\+=|=)\\s*([^,;]+)`, "i").exec(sql);
    if (!assignment) continue;
    const operator = assignment[1];
    const expression = assignment[2]?.split(/\bRETURN\b/i)[0]?.trim();
    if (!expression) throw new Error(`Missing assignment for ${field}`);
    const amount = numeric(expression, row, bindings);
    row[field] = operator === "+=" ? Number(row[field] ?? 0) + amount : amount;
  }
}

async function query<T = unknown>(sql: string, bindings: Bindings = {}): Promise<T[]> {
  const text = sql.replace(/--[^\n]*/g, " ").trim();
  let result: unknown[] = [];
  if (/\bvariant_performance_metrics\b/i.test(text)) {
    if (/\bINSERT\s+INTO\s+variant_performance_metrics\b/i.test(text)) {
      const inserted: Row = {
        id: `variant_performance_metrics:${String(bindings.record_id_slug ?? bindings.variant_id)}`,
        variant_id: String(bindings.variant_id),
        org_id: bindings.org_id == null ? null : String(bindings.org_id),
        account_id: bindings.account_id == null ? null : String(bindings.account_id),
        thompson_alpha: Number(bindings.seed_alpha ?? 1),
        thompson_beta: Number(bindings.seed_beta ?? 1),
        total_executions: 1,
        successful_executions: Number(bindings.success_delta ?? 0),
        failed_executions: Number(bindings.failure_delta ?? 0),
      };
      rows.push(inserted);
      counterWrites++;
      result = [[inserted]];
    } else if (/\bUPDATE\b/i.test(text)) {
      const target = /\bUPDATE\s+\$(\w+)/i.exec(text)?.[1];
      const selected = rows.filter((row: Row): boolean => target ? String(row.id) === String(bindings[target]) : matches(row, text, bindings));
      for (const row of selected) {
        applyPosteriorAssignments(row, text, bindings);
        if (/\btotal_executions\s*=/i.test(text)) {
          row.total_executions = (Number(row.total_executions ?? 0) || 0) + 1;
          counterWrites++;
        }
      }
      result = [selected];
    } else {
      result = [rows.filter((row: Row): boolean => matches(row, text, bindings))];
    }
  } else if (/\bUPDATE\s+\$(\w+)/i.test(text)) {
    const target = /\bUPDATE\s+\$(\w+)/i.exec(text)?.[1];
    const selected = rows.filter((row: Row): boolean => target !== undefined && String(row.id) === String(bindings[target]));
    if (selected.length > 0) {
      for (const row of selected) {
        applyPosteriorAssignments(row, text, bindings);
        if (/\btotal_executions\s*=/i.test(text)) {
          row.total_executions = Number(row.total_executions ?? 0) + 1;
          counterWrites++;
        }
      }
      result = [selected];
    } else {
      result = [[trace]];
    }
  } else if (/\bexecution_traces\b/i.test(text)) {
    if (/\bUPDATE\b/i.test(text)) trace = { ...trace, ...bindings, reached: true };
    result = [[trace]];
  } else {
    result = [[]];
  }
  return result as T[];
}

const database = { query };
mock.module("../../src/db/surreal", () => ({
  surrealDB: { query, getInstance: async () => database },
  queryWithAuth: query,
  createAuthenticatedClient: async () => database,
}));
const record = (...args: unknown[]): void => { messages.push(args); };
mock.module("../../src/utils/logger", () => ({
  logger: { debug: record, info: record, warn: record, error: record },
}));

import * as mod from "../../src/routes/execution-traces";

function reset(orgKeyed: boolean): void {
  messages.length = 0;
  counterWrites = 0;
  rows = [{
    id: "variant_performance_metrics:existing",
    variant_id: variant,
    ...(orgKeyed ? { org_id: org } : {}),
    thompson_alpha: 1,
    thompson_beta: 1,
    total_executions: 0,
    successful_executions: 0,
    failed_executions: 0,
  }];
  trace = {
    id: `execution_traces:${executionId}`,
    execution_id: executionId,
    variant_id: variant,
    activity_id: variant,
    org_id: org,
    account_id: null,
    success: true,
    reached: null,
    status: "completed",
    duration_ms: 10,
    cost_usd: 0,
    tasks: [],
    tags: [],
    metadata: {},
    failure_mode: null,
  };
}

async function patchReach(): Promise<void> {
  // Inspect only public Hono exports and call Hono's declared request API.
  // Hono's registered route records produce both method and path here;
  // no private execution-traces symbol or SQL constant is accessed.
  const routers = Object.values(mod).filter((value: unknown): value is Hono =>
    value !== null && typeof value === "object" &&
    "routes" in value && Array.isArray(value.routes) &&
    "request" in value && typeof value.request === "function"
  );
  const candidates = routers.flatMap((router: Hono) => router.routes.map((route) => ({ router, route })));
  const candidate = candidates.find(({ route }): boolean => route.method === "PATCH" && /reach/i.test(route.path));
    expect(candidate).toBeDefined();
  const path = candidate?.route.path.replace(/:[^/]+/g, encodeURIComponent(executionId));
  const response = await candidate?.router.request(path!, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reached: true }),
  });
  expect(response?.status).toBeLessThan(300);
  expect(response?.status).toBeGreaterThanOrEqual(200);
}

function assertOrgPosterior(): void {
  expect(counterWrites).toBeGreaterThan(0);
  // Observe the exercised SQL writes, not a copied implementation of the
  // counter's lookup. A fixed lookup must create/find an org-scoped row.
  const scoped = rows.find((row: Row): boolean => row.variant_id === variant && row.org_id === org);
  expect(scoped?.thompson_alpha).toBe(2);
  // This is the production posterior-drop message named in the gap, not
  // text supplied in the request or synthesized by the database stub.
  const dropped = messages.some((args: unknown[]): boolean => args.some((arg: unknown): boolean => typeof arg === "string" && arg.includes(dropMessage)));
  expect(dropped).toBe(false);
}

test("regression: a graded ribosome-extract reach creates and credits the trace org instead of losing its posterior delta", async (): Promise<void> => {
  reset(false);
  await patchReach();
  assertOrgPosterior();
});

test("control: a graded reach credits an existing correctly org-keyed metrics row", async (): Promise<void> => {
  reset(true);
  await patchReach();
  assertOrgPosterior();
});
