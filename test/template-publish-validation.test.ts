// Publish-time template validation, tested against the REAL defects it exists to stop
// and — just as importantly — against the corrected template that actually shipped, so
// the guard cannot be "safe" by rejecting everything.
import { describe, it, expect } from "bun:test";

// Mirrors the checks in routes/impulses.ts case 'activityTemplate_update'.
function validate(tasks: unknown[], declaredVars: string[]): string[] {
  const declared = new Set(declaredVars);
  const problems: string[] = [];
  const blob = JSON.stringify(tasks);
  const taskIds = new Set<string>();
  for (const t of tasks) {
    const id = (t as { id?: unknown })?.id;
    if (typeof id === "string" && id) taskIds.add(id);
  }
  for (const m of blob.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
    const name = m[1]!;
    if (declared.has(name)) continue;
    const base = name.replace(/_text$/, "");
    if (name.endsWith("_text") && taskIds.has(base)) continue;
    if (name.includes(".")) continue;
    problems.push(`task placeholder {{${name}}} has no declared variable and no producing task — it will render empty`);
  }
  const MOUNTED_PREFIXES = [
    "/v2/activities", "/v2/auth", "/v2/cluster", "/v2/connections", "/v2/events",
    "/v2/goal-paths", "/v2/impulses", "/v2/llm-router", "/v2/ribosome", "/v2/shapes",
    "/v2/tuning-params", "/v2/vessels",
    "/v1/", "/metrics", "/health", "/resolve", "/run-goal", "/concepts", "/egress",
    "/dispatch", "/shapes", "/active-dispatches", "/ws",
  ];
  for (const m of blob.matchAll(/"(https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?)(\/[^"']*)"/g)) {
    const path = m[2]!.split("?")[0]!;
    if (!MOUNTED_PREFIXES.some((pf) => path === pf || path.startsWith(pf))) {
      problems.push(`task URL path ${path} matches no route mounted by any fleet vessel — it will 404 on every dispatch`);
    }
  }
  return problems;
}

describe("publish-time template validation", () => {
  it("REJECTS the route that does not exist (the original reconcile defect)", () => {
    const p = validate([{ id: "reconcile", config: { url: "http://127.0.0.1:8080/v2/db/admin/reconcile-trace-store" } }], []);
    expect(p.length).toBe(1);
    expect(p[0]).toContain("/v2/db/admin/reconcile-trace-store");
  });

  it("REJECTS a placeholder nothing binds (the defect MY OWN first fix shipped)", () => {
    const p = validate([{ id: "reconcile", config: { url: "{{activity_api_endpoint}}/v2/impulses/resolve" } }], []);
    expect(p.length).toBe(1);
    expect(p[0]).toContain("activity_api_endpoint");
  });

  it("ACCEPTS that same placeholder once it is declared", () => {
    const p = validate([{ id: "reconcile", config: { url: "{{activity_api_endpoint}}/v2/impulses/resolve" } }], ["activity_api_endpoint"]);
    expect(p).toEqual([]);
  });

  it("ACCEPTS the corrected template that actually shipped — literal URL, real route", () => {
    const p = validate([
      { id: "acquire_lease", config: { type: "maintenanceLease_write", op: "acquire" } },
      { id: "extract_lease_token", config: { json: "{{acquire_lease_text}}", path: "token" } },
      { id: "reconcile", config: { url: "http://127.0.0.1:8080/v2/impulses/resolve", body: '{"impulse":{"pointer":{"lease_token":"{{extract_lease_token_text}}"}}}' } },
    ], []);
    expect(p).toEqual([]);
  });

  it("does not flag {{taskId_text}} — that is the engine's own cross-task binding", () => {
    const p = validate([{ id: "first" }, { id: "second", config: { json: "{{first_text}}" } }], []);
    expect(p).toEqual([]);
  });

  it("does not judge a REMOTE host's routes — they are not ours to know", () => {
    const p = validate([{ id: "t", config: { url: "https://api.example.com/whatever/path" } }], []);
    expect(p).toEqual([]);
  });

  it("catches both defect classes in one template", () => {
    const p = validate([{ id: "t", config: { url: "http://127.0.0.1:8080/v2/db/admin/nope", body: "{{unbound}}" } }], []);
    expect(p.length).toBe(2);
  });
});
