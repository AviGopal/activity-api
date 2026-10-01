/**
 * CHECK-FIRST (class-2) for gap conservation-residual-trend-route-was-deleted-by-an-autonomous-edit:
 * substrate-authored 53292c9 (2026-09-14) replaced the header line of
 * GET /conservation-residual-trend with a second POST /conservation-audit-emit, splicing the
 * rest of the old header into a comment. The file still typechecks, so the route silently 404s
 * and the learned conservation templates that GET it fail. Red on purpose until fixed.
 */
import { describe, expect, it } from "bun:test";
import app from "../../src/routes/activities";

const routes = (): Array<{ method: string; path: string }> =>
  ((app as unknown as { routes: Array<{ method: string; path: string }> }).routes ?? []);

describe("conservation routes are registered exactly once", () => {
  it("GET /conservation-residual-trend is registered", () => {
    expect(routes().some((r) => r.method === "GET" && r.path === "/conservation-residual-trend")).toBe(true);
  });
  it("POST /conservation-audit-emit is registered exactly once", () => {
    expect(routes().filter((r) => r.method === "POST" && r.path === "/conservation-audit-emit").length).toBe(1);
  });
  it("control: the router exposes its routes and POST /conservation-audit-emit is registered", () => {
    expect(routes().length).toBeGreaterThan(10);
    expect(routes().some((r) => r.method === "POST" && r.path === "/conservation-audit-emit")).toBe(true);
  });
});
