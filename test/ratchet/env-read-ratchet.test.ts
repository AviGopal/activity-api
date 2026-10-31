/**
 * ENV-READ RATCHET — behaviour env switches can only shrink.
 *
 * Law 1: runtime behaviour is steered by shaped impulses read at use time. An env var is frozen at
 * process start, invisible to traces and the walk, and unlearnable, so it is legitimate only for
 * bootstrap (secrets/credentials, own and peer endpoints, identity/node names, filesystem roots, log
 * level, test-only flags). This test pins every env name activity-api's src/ reads:
 *
 *   (a) every name the scanner finds in src/**\/*.ts (not *.test.ts, not test/fixture dirs) must be in
 *       env-read-ratchet.list.json — a NEW name fails until the list names it, with a class and reason;
 *   (b) the list's behaviour set must be a SUBSET of FROZEN_BEHAVIOUR below, and no frozen name may be
 *       re-classed as bootstrap. Adding a behaviour switch FAILS; removing one PASSES;
 *   (c) every entry carries a reason — checked for presence only, never content, so a stale reason
 *       can never fail the gate.
 * Entries no longer read are printed as stale (a warning, not a failure: shrink is good).
 *
 * A new bootstrap name is allowed only by an explicit list addition with a reason, visible in the diff.
 * Dynamic reads (ENV[expr]) are pinned as `<dynamic>@file:<normalised expression>#n` (whitespace and
 * comments removed; n = occurrence index of that expression in the file), never by line: an edit that
 * only shifts lines cannot wedge the list, while a new dynamic read is a new pin and fails.
 *
 * This directory is operator-owned and closed by design: see README.md. A behaviour change goes through
 * a shaped mechanism, never through editing the list or FROZEN_BEHAVIOUR.
 *
 * RESIDUALS (forms the scanner does not catch; each is a test.todo below):
 *   - an env object passed as an argument to a function and read through a parameter that has no
 *     `= process.env` default (`f(process.env)` → `function f(e) { e.X }`);
 *   - a helper that takes the key as a NON-first parameter, or is reached through a namespace import
 *     (`cfg.env("X")`) or a second-hand alias (`const g = env; g("X")`);
 *   - whole-env pass-through (`{ ...process.env }`, `Object.entries(process.env)`) is not a read of a
 *     name and is not recorded.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSources, scanEnvReads, type SourceFile } from "./env-read-scanner";

type EnvClass = "bootstrap" | "behaviour";
interface Entry { name: string; class: EnvClass; reason: string }

/** Today's behaviour names, frozen. This set may only SHRINK: delete a name when its read is migrated. */
const FROZEN_BEHAVIOUR: readonly string[] = [
  "ACCELERATOR_FLAG_INTERVAL_MS",
  "ACCOUNT_ID_REQUIRED",
  "ANALYSIS_API_RETRY_ATTEMPTS",
  "ANALYSIS_API_RETRY_DELAY",
  "ANALYSIS_API_TIMEOUT",
  "AUTH_KEY_CACHE_TTL_MS",
  "AUTO_PROMOTE_MIN_SAMPLES",
  "AUTO_PROMOTE_MIN_SUCCESS_RATE",
  "CLUSTER_ASSIGNMENT_CACHE_TTL_MS",
  "CLUSTER_SHADOW_SAMPLE_RATE",
  "CONCEPT_DB_CLUSTER_TIMEOUT_MS",
  "CONCEPT_DB_EMBED_TIMEOUT_MS",
  "CROSS_SIG_REPUTATION_MIN_GLOBAL_OBS",
  "CROSS_SIG_REPUTATION_PENALTY",
  "DB_POOL_ENABLED",
  "DB_POOL_MAX",
  "DENSE_BACKFILL_ENABLED",
  "DENSE_EMBEDDING_HNSW_ENABLED",
  "DISCOVERY_ENABLED",
  "DISCOVERY_HEARTBEAT_INTERVAL_MS",
  "DISCOVERY_RETRY_ATTEMPTS",
  "DISCOVERY_RETRY_BACKOFF_MS",
  "DUAL_WRITE_ENABLED",
  "EMBEDDING_DIMENSION",
  "EMBEDDING_LOOKUP_CACHE_SIZE",
  "EMBEDDING_LOOKUP_TIMEOUT_MS",
  "EMBEDDING_MODEL",
  "EMBEDDING_PRIOR_ENABLED",
  "EMBEDDING_PRIOR_OBSERVER_ENABLED",
  "EMBEDDING_PROVIDER",
  "EMBEDDING_SEND_DIMENSIONS",
  "EMPIRICAL_BADNESS_FLOOR",
  "EMPIRICAL_BADNESS_MIN_OBS",
  "EMPIRICAL_BADNESS_MIN_RATE",
  "EXEMPLAR_BULK_DELAY_MS",
  "EXEMPLAR_BURST_THRESHOLD",
  "EXEMPLAR_N",
  "EXEMPLAR_SELECTOR_ENABLED",
  "EXEMPLAR_SELECTOR_INTERVAL_MS",
  "EXEMPLAR_SELECTOR_RUN_ON_BOOT",
  "GRADED_YIELD_SUCCESS",
  "HEARTBEAT_WORKER_ENABLED",
  "IMPULSE_DECAY_HALF_LIFE_SECONDS",
  "LEARNING_TRACK_CADENCE_MS",
  "LEARNING_TRACK_CLASSIFIER_ENABLED",
  "LEARNING_TRACK_MIN_SAMPLES",
  "LEARNING_TRACK_SAMPLE_WINDOW",
  "LEARNING_TRACK_SHAPE_LEARNING_THRESHOLD",
  "LEARNING_TRACK_SHAPE_SYSTEM_THRESHOLD",
  "LEARNING_TRACK_TASK_LEARNING_THRESHOLD",
  "LEARNING_TRACK_TASK_SYSTEM_THRESHOLD",
  "M1_OBSERVER_FEATURE_DIM",
  "M1_OBSERVER_KAPPA",
  "M1_OBSERVER_LAMBDA",
  "M1_OBSERVER_MIN_OBS",
  "M1_OBSERVER_ORG_ID",
  "M1_OBSERVER_REFIT_INTERVAL_MS",
  "M1_OBSERVER_REFIT_TRIGGER",
  "M1_OBSERVER_WINDOW",
  "NODE_ENV",
  "POSTERIOR_COALESCE",
  "POSTERIOR_FLUSH_MS",
  "PRIOR_SEED_ENABLED",
  "PRIOR_SEED_K",
  "PRIOR_SEED_KAPPA",
  "PRIOR_SEED_TIMEOUT_MS",
  "PROMOTE_GATE_DISABLED",
  "PROMOTE_GATE_K",
  "PROMOTE_GATE_THRESHOLD_MEAN",
  "PROMOTE_GATE_THRESHOLD_SAMPLES",
  "RECOMMEND_ESCALATABLE_DISCOUNT",
  "RECOMMEND_NO_COVERAGE_DISCOUNT",
  "RECOMMEND_PARTIAL_COVERAGE_DISCOUNT",
  "RECOMMEND_SIGNATURE_SAMPLING_FLOOR",
  "REDIS_METRICS_TTL",
  "REDIS_TEMPLATE_TTL",
  "REPAIR_SIGNATURE_CONSUME",
  "REPLICATION_INTERVAL_MS",
  "REPLICATION_MAX_BATCHES",
  "REPLICATION_PULL_LIMIT",
  "REQUIRE_AUTH",
  "SF_BLEND",
  "SF_BLEND_WEIGHT",
  "SF_DISCOUNT",
  "SF_TOPK",
  "SIGNATURE_CARDINALITY_CAP",
  "SIGNATURE_CLUSTER_INTERVAL_MS",
  "SIGNATURE_CLUSTER_MAX_SIZE",
  "SIGNATURE_CLUSTER_MIN_SIMILARITY",
  "SIGNATURE_CLUSTER_N_MIN",
  "SUCCESSOR_FEATURES",
  "SURREALDB_AUTH_ENABLED",
  "SURREAL_MAX_CONCURRENT_QUERIES",
  "TASK_GENERATION_ENABLED",
  "TD_LAMBDA",
  "TEMPLATE_LIFECYCLE_MIN_DELTA",
  "TEMPLATE_LIFECYCLE_MIN_SAMPLES",
  "THOMPSON_SAMPLING_SEED",
  "TRACE_LIST_DEFAULT_WINDOW_HOURS",
  "TRACE_RETENTION_ACTIVITIES",
  "TRACE_RETENTION_AUTO",
  "TRACE_RETENTION_AUTO_MAX",
  "TRACE_RETENTION_CEILING_BUDGET_MS",
  "TRACE_RETENTION_CEILING_PER_SWEEP_CAP",
  "TRACE_RETENTION_DEFAULT_FAILURE_CAP",
  "TRACE_RETENTION_DEFAULT_SUCCESS_CAP",
  "TRACE_RETENTION_DELETE_BATCH",
  "TRACE_RETENTION_DRY_RUN",
  "TRACE_RETENTION_ENABLED",
  "TRACE_RETENTION_GLOBAL_CEILING",
  "TRACE_RETENTION_GLOBAL_CEILING_BYTES",
  "TRACE_RETENTION_GLOBAL_CEILING_ENABLED",
  "TRACE_RETENTION_HOT_WINDOW_MS",
  "TRACE_RETENTION_INTERVAL_MS",
  "TRACE_RETENTION_ORPHAN_BUDGET_MS",
  "TRACE_RETENTION_ORPHAN_MIN_AGE_MS",
  "TRACE_RETENTION_ORPHAN_REAP_CAP",
  "TRACE_RETENTION_ORPHAN_REAP_ENABLED",
  "TRACE_RETENTION_OVERRIDES",
  "TRACE_RETENTION_ROW_SAMPLE_N",
  "TRACE_STORE_CAP",
  "TRACE_STORE_HOT_WINDOW_DAYS",
  "TRACE_STORE_RESERVOIR_PER_ACTIVITY",
  "TRACE_STORE_SUCCESS_SAMPLE_ACTIVITIES",
  "TRACE_STORE_SUCCESS_SAMPLE_RATE",
  "UCB_GRADED_MEAN",
  "VESSEL_CLEANUP_ENABLED",
  "YIELD_COST_REF",
  "YIELD_FLOOR",
  "YIELD_PROD_REF",
];

/**
 * Positive control: a broken scanner must not pass vacuously. Today's scan finds 178 names, 45 of
 * them bootstrap; the floor is set from the BOOTSTRAP count and the anchors are bootstrap names, so
 * migrating every behaviour read away (the end state this ratchet drives) never trips it.
 */
const MIN_REAL_NAMES = 33;
const ANCHOR_NAMES: readonly string[] = ["PORT", "METABOB_API_KEY", "SURREALDB_URL", "VESSEL_ID"];

const ROOT = join(import.meta.dir, "..", "..");
const LIST_PATH = join(import.meta.dir, "env-read-ratchet.list.json");

function loadList(): Entry[] {
  return JSON.parse(readFileSync(LIST_PATH, "utf8")) as Entry[];
}

interface Verdict { failures: string[]; stale: string[] }

/** The ratchet itself, pure over (scanned names, list, frozen behaviour set). */
function check(scanned: Iterable<string>, list: Entry[], frozen: readonly string[]): Verdict {
  const failures: string[] = [];
  const read = new Set(scanned);
  const frozenSet = new Set(frozen);
  const listed = new Map<string, Entry>();
  for (const e of list) {
    if (listed.has(e.name)) failures.push(`duplicate list entry: ${e.name}`);
    listed.set(e.name, e);
    if (e.class !== "bootstrap" && e.class !== "behaviour") failures.push(`${e.name}: class must be "bootstrap" or "behaviour", got ${JSON.stringify(e.class)}`);
    if (typeof e.reason !== "string" || e.reason.trim() === "") failures.push(`${e.name}: list entry has no reason`);
    if (e.class === "behaviour" && !frozenSet.has(e.name)) {
      failures.push(`${e.name}: NEW behaviour env switch refused — steer this behaviour with a shaped impulse read at use time (law 1), not an env var`);
    }
    if (e.class === "bootstrap" && frozenSet.has(e.name)) {
      failures.push(`${e.name}: is a frozen behaviour switch and may not be re-classed as bootstrap`);
    }
  }
  for (const name of [...read].sort()) {
    if (!listed.has(name)) {
      failures.push(`${name}: env read not in env-read-ratchet.list.json — a behaviour switch is refused; a bootstrap name needs an explicit entry with a reason`);
    }
  }
  const stale = [...listed.keys()].filter((n) => !read.has(n)).sort();
  return { failures, stale };
}

const namesOf = (files: SourceFile[]): Set<string> => new Set(scanEnvReads(files).map((r) => r.name));
let realCache: Set<string> | null = null;
/** Today's real scan of src/, computed once per run (a fresh copy each call, so tests cannot share edits). */
const realNames = (): Set<string> => new Set((realCache ??= namesOf(loadSources(ROOT))));
const fixture = (text: string, path = "src/fixture.ts"): SourceFile[] => [{ path, text }];

describe("env-read ratchet (activity-api)", () => {
  test("every env read is pinned; behaviour switches can only shrink", () => {
    const { failures, stale } = check(realNames(), loadList(), FROZEN_BEHAVIOUR);
    if (stale.length > 0) console.warn(`[env-read-ratchet] stale list entries (no longer read — remove them): ${stale.join(", ")}`);
    expect(failures).toEqual([]);
  });

  test("positive control: the scanner finds today's real reads", () => {
    const names = realNames();
    expect(names.size).toBeGreaterThanOrEqual(MIN_REAL_NAMES);
    for (const a of ANCHOR_NAMES) expect(names.has(a)).toBe(true);
  });

  test("the list's behaviour entries are exactly a subset of the frozen set", () => {
    const behaviour = loadList().filter((e) => e.class === "behaviour").map((e) => e.name);
    for (const n of behaviour) expect(FROZEN_BEHAVIOUR).toContain(n);
  });
});

describe("env-read ratchet must-fails (fixtures, never real src)", () => {
  const list = (): Entry[] => loadList();

  test("a new behavioural process.env.FOO_ENABLED read FAILS", () => {
    const real = realNames();
    const scanned = new Set([...real, ...namesOf(fixture(`if (process.env.FOO_ENABLED === "1") enable();`))]);
    const v = check(scanned, list(), FROZEN_BEHAVIOUR);
    expect(v.failures.some((f) => f.startsWith("FOO_ENABLED:"))).toBe(true);
  });

  test("adding a behaviour entry to the list FAILS", () => {
    const real = realNames();
    const scanned = new Set([...real, "FOO_ENABLED"]);
    const v = check(scanned, [...list(), { name: "FOO_ENABLED", class: "behaviour", reason: "new toggle" }], FROZEN_BEHAVIOUR);
    expect(v.failures.some((f) => f.startsWith("FOO_ENABLED:") && f.includes("NEW behaviour"))).toBe(true);
  });

  test("re-classing a frozen behaviour name as bootstrap FAILS", () => {
    const real = realNames();
    const target = FROZEN_BEHAVIOUR.find((n) => real.has(n)) ?? FROZEN_BEHAVIOUR[0]!;
    const edited = list().map((e) => (e.name === target ? { ...e, class: "bootstrap" as const } : e));
    const v = check(real, edited, FROZEN_BEHAVIOUR);
    expect(v.failures.some((f) => f.startsWith(`${target}:`) && f.includes("re-classed"))).toBe(true);
  });

  test("a list entry without a reason FAILS", () => {
    const real = realNames();
    const edited = list().map((e, i) => (i === 0 ? { ...e, reason: " " } : e));
    expect(check(real, edited, FROZEN_BEHAVIOUR).failures.some((f) => f.includes("has no reason"))).toBe(true);
  });

  test("removing a list entry whose read is also gone PASSES (shrink is allowed)", () => {
    // Fixture form: the read and its entry both go.
    const before = fixture(`const a = process.env.ALPHA_ENABLED === "1";\nconst p = process.env.PORT;`);
    const after = fixture(`const p = process.env.PORT;`);
    const fixtureList: Entry[] = [
      { name: "ALPHA_ENABLED", class: "behaviour", reason: "toggle" },
      { name: "PORT", class: "bootstrap", reason: "listen port" },
    ];
    expect(check(namesOf(before), fixtureList, ["ALPHA_ENABLED"]).failures).toEqual([]);
    expect(check(namesOf(after), fixtureList.slice(1), ["ALPHA_ENABLED"]).failures).toEqual([]);
    // Real form: drop one real frozen behaviour name from both the scan and the list.
    const real = realNames();
    const target = FROZEN_BEHAVIOUR.find((n) => real.has(n));
    if (target) {
      const scanned = new Set([...real].filter((n) => n !== target));
      // The removal adds no failure of its own (compared with today's verdict, which the first test pins at []).
      const before = check(real, list(), FROZEN_BEHAVIOUR).failures;
      expect(check(scanned, list().filter((e) => e.name !== target), FROZEN_BEHAVIOUR).failures).toEqual(before);
    }
  });

  test("a removed read whose entry stays is reported stale, not failed", () => {
    const v = check(new Set<string>(), [{ name: "GONE", class: "bootstrap", reason: "x" }], []);
    expect(v.failures).toEqual([]);
    expect(v.stale).toEqual(["GONE"]);
  });

  test("an aliased env object is caught: const e = process.env; if (e.BAR) …", () => {
    const names = namesOf(fixture(`const e = process.env;\nif (e.BAR) run();\nconst q = e["BAZ"];`));
    expect(names.has("BAR")).toBe(true);
    expect(names.has("BAZ")).toBe(true);
    expect(check(names, list(), FROZEN_BEHAVIOUR).failures.some((f) => f.startsWith("BAR:"))).toBe(true);
  });

  test("the scanner covers every recognised form", () => {
    const text = [
      `const a = process.env.F_DOT;`,
      `const b = process.env["F_DQ"] ?? process.env['F_SQ'];`,
      "const c = process.env[`F_BT`];",
      `const d = process.env?.F_OPT;`,
      `const e1 = Bun.env.F_BUN; const e2 = Bun.env["F_BUN_IDX"];`,
      `const f = import.meta.env.F_META;`,
      `const { F_DS1, F_DS2: renamed, F_DS3 = "x" } = process.env;`,
      `const { F_BDS } = Bun.env;`,
      `if ("F_IN" in process.env) {}`,
      `process.env.F_WRITE = "1";`,
      `function g(env: Record<string, string | undefined> = process.env) { return env.F_PARAM ?? env["F_PARAM_IDX"]; }`,
      `const h = opts.env ?? process.env; h.F_COALESCE;`,
      `const dyn = process.env[someKey];`,
      `const { ...rest } = process.env;`,
      `const helper = (key: string, d: string) => process.env[key] ?? d;`,
      `const viaHelper = helper("F_HELPER", "x");`,
      `const helperInt = (key: string, d: number) => Number(helper(key, String(d)));`,
      `const viaChain = helperInt("F_HELPER_CHAIN", 1);`,
      `const viaHelperDyn = helper(computed, "x");`,
      `// process.env.F_COMMENT is not a read`,
      `/* process.env.F_BLOCK_COMMENT */`,
      `const msg = "process.env.F_IN_STRING is text";`,
      "const tmpl = `gated behind process.env.${name} and ${process.env.F_TEMPLATE_HOLE}`;",
    ].join("\n");
    const names = namesOf(fixture(text));
    for (const n of ["F_DOT", "F_DQ", "F_SQ", "F_BT", "F_OPT", "F_BUN", "F_BUN_IDX", "F_META", "F_DS1", "F_DS2", "F_DS3", "F_BDS", "F_IN", "F_WRITE", "F_PARAM", "F_PARAM_IDX", "F_COALESCE", "F_HELPER", "F_HELPER_CHAIN", "F_TEMPLATE_HOLE"]) {
      expect([n, names.has(n)]).toEqual([n, true]);
    }
    for (const n of ["F_COMMENT", "F_BLOCK_COMMENT", "F_IN_STRING", "renamed", "$"]) expect([n, names.has(n)]).toEqual([n, false]);
    const dynamic = [...names].filter((n) => n.startsWith("<dynamic>@src/fixture.ts:"));
    // ENV[someKey], the `...rest` destructure, helper's own ENV[key], helper(computed).
    expect(dynamic.sort()).toEqual([
      "<dynamic>@src/fixture.ts:helper(computed)#1",
      "<dynamic>@src/fixture.ts:process.env[key]#1",
      "<dynamic>@src/fixture.ts:process.env[someKey]#1",
      "<dynamic>@src/fixture.ts:{...rest}=process.env#1",
    ]);
  });

  test("a helper imported by name from another file is resolved at its call sites", () => {
    const files: SourceFile[] = [
      { path: "src/config.ts", text: `export const env = (key: string, fallback: string): string => process.env[key] ?? fallback;` },
      { path: "src/use.ts", text: `import { env } from "./config.js";\nconst x = env("F_IMPORTED", "d");` },
      { path: "src/other.ts", text: `const env = (s: string) => s;\nenv("NOT_AN_ENV_READ");` },
    ];
    const names = namesOf(files);
    expect(names.has("F_IMPORTED")).toBe(true);
    expect(names.has("NOT_AN_ENV_READ")).toBe(false);
  });

  test("a new dynamic read FAILS (pinned by file + expression)", () => {
    const real = realNames();
    const scanned = new Set([...real, ...namesOf(fixture(`const v = process.env[name];`, "src/new-dynamic.ts"))]);
    const v = check(scanned, list(), FROZEN_BEHAVIOUR);
    expect(v.failures.some((f) => f.startsWith("<dynamic>@src/new-dynamic.ts:process.env[name]#1:"))).toBe(true);
  });

  test("lines shifting above a pinned dynamic read still PASS; a new dynamic read FAILS", () => {
    const pinned = `const get = (key: string) => process.env[ key ];`;
    const fixtureList: Entry[] = [{ name: "<dynamic>@src/cfg.ts:process.env[key]#1", class: "bootstrap", reason: "helper plumbing" }];
    expect(check(namesOf(fixture(pinned, "src/cfg.ts")), fixtureList, []).failures).toEqual([]);
    // Lines inserted above, a comment, and reformatting: the pin is unchanged.
    const shifted = `import { x } from "./x";\n\n// a new comment\nexport const y = 1;\n${pinned.replace("[ key ]", "[key /* k */]")}`;
    expect([...namesOf(fixture(shifted, "src/cfg.ts"))]).toEqual(["<dynamic>@src/cfg.ts:process.env[key]#1"]);
    expect(check(namesOf(fixture(shifted, "src/cfg.ts")), fixtureList, []).failures).toEqual([]);
    // A second occurrence of the same expression, or a different expression, is a NEW pin and fails.
    const again = `${shifted}\nconst other = (key: string) => process.env[key];`;
    expect(check(namesOf(fixture(again, "src/cfg.ts")), fixtureList, []).failures.some((f) => f.startsWith("<dynamic>@src/cfg.ts:process.env[key]#2:"))).toBe(true);
    const different = `${shifted}\nconst z = process.env[flagName];`;
    expect(check(namesOf(fixture(different, "src/cfg.ts")), fixtureList, []).failures.some((f) => f.startsWith("<dynamic>@src/cfg.ts:process.env[flagName]#1:"))).toBe(true);
  });

  // RESIDUALS: each todo asserts the catch we WANT; it fails today, which is what keeps it a todo
  // (`bun test --todo` runs them; one that starts passing means the residual closed — promote it).
  test.todo("RESIDUAL: env passed as an argument and read through a parameter with no `= process.env` default is not caught", () => {
    expect(namesOf(fixture(`function f(e: Record<string, string | undefined>) { return e.R_ARG; }\nf(process.env);`)).has("R_ARG")).toBe(true);
  });
  test.todo("RESIDUAL: a helper taking the key as a NON-first parameter is not resolved", () => {
    expect(namesOf(fixture(`const get = (d: string, key: string) => process.env[key] ?? d;\nget("x", "R_SECOND");`)).has("R_SECOND")).toBe(true);
  });
  test.todo("RESIDUAL: a helper reached through a namespace import (cfg.env(\"X\")) is not resolved", () => {
    const files: SourceFile[] = [
      { path: "src/config.ts", text: `export const env = (key: string, d: string) => process.env[key] ?? d;` },
      { path: "src/use.ts", text: `import * as cfg from "./config.js";\ncfg.env("R_NAMESPACE", "d");` },
    ];
    expect(namesOf(files).has("R_NAMESPACE")).toBe(true);
  });
  test.todo("RESIDUAL: a helper reached through a second-hand alias (const g = env; g(\"X\")) is not resolved", () => {
    expect(namesOf(fixture(`const env = (key: string, d: string) => process.env[key] ?? d;\nconst g = env;\ng("R_ALIAS_HELPER", "d");`)).has("R_ALIAS_HELPER")).toBe(true);
  });
});
