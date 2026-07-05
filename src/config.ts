/**
 * Configuration module for metabob-activity-api
 * Loads environment variables and provides typed configuration
 */

export interface Config {
  port: number;
  host: string;

  // Database
  surrealdb: {
    url: string;
    namespace: string;
    database: string;
    username: string;
    password: string;
    authEnabled: boolean;  // Whether SurrealDB requires authentication
  };

  // Redis
  redis: {
    url: string;
    ttl: {
      template: number;     // Template cache TTL
      metrics: number;      // Metrics cache TTL
    };
  };

  // Analysis API (M3 - Impulse Bridge)
  analysisApi: {
    url: string;
    timeout: number;       // Request timeout in ms
    retryAttempts: number; // Number of retry attempts
    retryDelay: number;    // Delay between retries in ms
  };

  // Security
  auth: {
    requireAuth: boolean;  // Set to false for development
    jwtSecret: string;     // JWT signing secret
    /**
     * Phase A account_id rollout flag (OpenSpec
     * activity-api-account-id-migration-2026-04-28).
     *
     * - false (default): legacy org_id behavior. Phase B handlers may also
     *   read/write `account_id`, but JWT contexts WITHOUT an `account_id`
     *   claim are still accepted and routed via `org_id`.
     * - true: PERMISSIONS clauses (post-Phase C) and route-level checks
     *   require `$token.account_id`. Requests carrying only `org_id` are
     *   rejected. Flips to `true` in Phase D after the data migration in
     *   Phase F completes.
     *
     * Override via env var: `ACCOUNT_ID_REQUIRED=true`.
     */
    accountIdRequired: boolean;
  };

  // Logging
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logFormat: 'json' | 'text';

  // CORS
  cors: {
    origins: string[];
  };

  // Discovery Vessel Integration
  discovery: {
    enabled: boolean;
    endpoint: string;
    vesselId: string;
    heartbeatIntervalMs: number;
    retryAttempts: number;
    retryBackoffMs: number;
    shapes: string[];  // Default shapes this vessel can resolve
    /** RESOLVER-DESCRIPTION ADVERTISEMENT (2026-06-28): per-shape one-liners
     *  (shape id → "produces + when to use it") so a decomposition planner can
     *  match this vessel's data resolvers from their descriptions alone. Only
     *  keys present in `shapes` are honoured downstream. */
    shapeDescriptions?: Record<string, string>;
  };
}

function parseEnvInt(key: string, defaultValue: number): number {
  const value = process.env[key];
  return value ? parseInt(value, 10) : defaultValue;
}

/**
 * Single source of truth for the JWT signing secret.
 *
 * The same value is used by:
 *   - `generateJwtToken` / `validateJwtToken` (src/services/auth.ts) at runtime
 *   - the `apikey_token` ACCESS method KEY in SurrealDB (sql/000-auth-schema.surql,
 *     substituted by scripts/init-database.ts at deploy time)
 *
 * In production, the value MUST come from the `JWT_SECRET` env var (sourced
 * from the k8s secret `metabob-activity-api.jwt-secret`). If unset, this
 * throws at startup — better to refuse to boot than to ship a known-bad
 * secret that causes silent auth mismatches like the v1.12.0 canary bug
 * (POST /v2/impulses/resolve returning "The access method cannot be used in
 * the requested operation").
 *
 * In non-production environments, an explicit dev-only sentinel is used so
 * `bun run dev` and unit tests work without manual setup; a warning is
 * logged so it's never confused with a real secret.
 */
function resolveJwtSecret(): string {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  const nodeEnv = process.env.NODE_ENV ?? 'development';
  if (nodeEnv === 'production') {
    throw new Error(
      'JWT_SECRET environment variable is required in production. ' +
      'It must come from the k8s secret `metabob-activity-api.jwt-secret`. ' +
      'Refusing to start with a fallback default — see CLAUDE.md "JWT secret".'
    );
  }

  // Loud, single dev-only sentinel. Mirrors scripts/init-database.ts so
  // schema KEY and runtime config agree even without JWT_SECRET set.
  // eslint-disable-next-line no-console
  console.warn(
    '[config] JWT_SECRET unset; using non-production sentinel ' +
    '"dev-only-jwt-secret-do-not-use-in-prod". Do NOT use in production.'
  );
  return 'dev-only-jwt-secret-do-not-use-in-prod';
}

function parseEnvBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

/**
 * Validates SurrealDB namespace format and existence
 * Fails fast on invalid configuration to prevent silent query failures
 */
function validateNamespace(ns: string | undefined): string {
  if (!ns) {
    throw new Error('SURREALDB_NAMESPACE environment variable is required. Set it to "activity-system" for Activity API deployment.');
  }
  
  // Validate namespace format (alphanumeric, underscore, hyphen)
  if (!/^[a-z0-9_-]+$/i.test(ns)) {
    throw new Error(`Invalid namespace format: "${ns}". Must contain only alphanumeric characters, underscores, and hyphens.`);
  }
  
  return ns;
}

/**
 * Generates vessel ID from environment variables
 * Uses VESSEL_ID if set, otherwise generates from hostname + pod name
 */
function generateVesselId(): string {
  if (process.env.VESSEL_ID) {
    return process.env.VESSEL_ID;
  }

  // In Kubernetes, use pod name if available
  const hostname = process.env.HOSTNAME || 'activity-api';
  const podName = process.env.POD_NAME || hostname;

  return `activity-api-${podName}`;
}

export function loadConfig(): Config {
  return {
    port: parseEnvInt('PORT', 8080),
    host: process.env.HOST || '0.0.0.0',
    
    surrealdb: {
      url: process.env.SURREALDB_URL || 'http://localhost:8000',
      namespace: validateNamespace(process.env.SURREALDB_NAMESPACE),
      database: process.env.SURREALDB_DATABASE || 'learning_loop',
      username: process.env.SURREALDB_USERNAME || 'root',
      password: process.env.SURREALDB_PASSWORD || 'changeme',
      authEnabled: parseEnvBool('SURREALDB_AUTH_ENABLED', true),  // Default true for safety
    },
    
    redis: {
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      ttl: {
        template: parseEnvInt('REDIS_TEMPLATE_TTL', 3600), // 1 hour
        metrics: parseEnvInt('REDIS_METRICS_TTL', 300),    // 5 minutes
      },
    },

    analysisApi: {
      url: process.env.ANALYSIS_API_URL || 'http://metabob-analysis-api:8080',
      timeout: parseEnvInt('ANALYSIS_API_TIMEOUT', 30000),
      retryAttempts: parseEnvInt('ANALYSIS_API_RETRY_ATTEMPTS', 3),
      retryDelay: parseEnvInt('ANALYSIS_API_RETRY_DELAY', 1000),
    },

    auth: {
      requireAuth: parseEnvBool('REQUIRE_AUTH', false),
      jwtSecret: resolveJwtSecret(),
      // Phase A: default false. Override via env var ACCOUNT_ID_REQUIRED=true.
      // Will flip to true in Phase D after Phase F backfill completes.
      accountIdRequired: parseEnvBool('ACCOUNT_ID_REQUIRED', false),
    },
    
    logLevel: (process.env.LOG_LEVEL || 'info') as Config['logLevel'],
    logFormat: (process.env.LOG_FORMAT || 'text') as Config['logFormat'],
    
    cors: {
      origins: process.env.CORS_ORIGINS?.split(',') || ['*'],
    },

    discovery: {
      enabled: parseEnvBool('DISCOVERY_ENABLED', true),
      endpoint: process.env.DISCOVERY_VESSEL_ENDPOINT || 'http://discovery-vessel.activity-system.svc.cluster.local:8080',
      vesselId: generateVesselId(),
      heartbeatIntervalMs: parseEnvInt('DISCOVERY_HEARTBEAT_INTERVAL_MS', 60000), // 60 seconds
      retryAttempts: parseEnvInt('DISCOVERY_RETRY_ATTEMPTS', 3),
      retryBackoffMs: parseEnvInt('DISCOVERY_RETRY_BACKOFF_MS', 1000),
      // Entries must match case statements in src/routes/impulses.ts.
      // Do not advertise shapes that return 410 Gone or have no case.
      shapes: [
        'activityExecutionTrace',
        'activityTemplate',
        'activityMetrics',
        'executionTraceList',
        'variantMetricsSummary',
        // Phase 9 (2026-04-30): per-variant Thompson posteriors as a routable
        // shape. Lifts the implicit Thompson vessel inside activity-api into
        // the standard impulse → resolver dispatch path. Pointer fields:
        // activity_variant_id (required), shape_signature (opt), context_bucket
        // (opt). Response: { alpha, beta, sample_count, success_count,
        // failure_count }. Existing REST handler at GET /v2/activities/:id/
        // variant-scores remains for backward compatibility (variantMetrics-
        // Summary aggregates across variants; thompson_posterior is per-
        // variant precise). See docs/impulse-types/thompson_posterior.md.
        'thompson_posterior',
        // Phase 10 P4.5 (2026-04-30): cached resolutions for previously
        // missing impulse shapes. Slot-binding consults this shape
        // before triggering create-shape-provider-goal escalation —
        // when prior resolution data exists the cached entry tells the
        // dispatcher which activity / vessel / sub-goal to use,
        // skipping a full recursive cycle. Pointer fields: shape
        // (required), account_id (opt). Response carries the same
        // row layout as GET /v2/activities/shape-gap-resolution.
        'shape_gap_resolution',
        // Phase 22 (Autonomous Vessel Forge): forwards to discovery-vessel to
        // count active producers for a shape. Used by slot-binding's
        // check_discovery_for_producer task to branch between forge (0 producers)
        // and create-shape-provider-goal (>0 producers). Non-fatal — returns
        // {count:0} when discovery is unavailable.
        'shape_producer_inventory',
        'activityTemplateRecommendation',
        'activityTemplatesByMetrics',
        'executionTraces',
        'goal',
        'toolRiskProfile',
        'compositionSuccess',
        'impulseRelevance',
        'preValidationResult',
        // templateAuditReport: per-template deficiency report (read-only).
        // Scans stored templates and surfaces missing shapes/tags, default
        // placeholders, hardcoded URLs, etc., with optional semantic-tags
        // backfill proposals. Feeds audit-and-backfill activities.
        'templateAuditReport',
        // executionTraceWithSignatures: recent execution traces hydrated with
        // a per-impulse (pointer_type, shape) signature map. Read-only; feeds
        // the minibob co-occurrence extractor (commit 1f8d703) so it can do
        // signature reasoning without a second round trip per impulse id.
        'executionTraceWithSignatures',
        // traceAggregateReport: FAST server-side GROUP BY / COUNT / SUM over the
        // indexed execution-trace table (failure-count-by-template, cost-by-
        // activity, executions-by-status over a window). The aggregate path the
        // decomposition planner should PREFER over executionTraceWithSignatures
        // for operator report/ranking/sum goals — it computes the answer in the
        // DB instead of shipping raw rows to the LLM (which timed out at 269K
        // rows). Read-only, bounded, returns empty-but-valid (never a timeout).
        'traceAggregateReport',
        // contextThompsonScores: paginated read over context_thompson_scores rows.
        // Supports filtering by templateId, signatureVersion, minObservations.
        // Powers harness discrimination stat (§6) and operator inspection.
        'contextThompsonScores',
        // topologyCoverage: read-only summary of (pool-signature × template)
        // exploration coverage. Backed by GET /v2/activities/topology-coverage;
        // returns distinct_pool_signatures, total_v1_observations,
        // avg_templates_per_signature, top_signatures, dark_signature_count,
        // and oldest/newest timestamps. Returns cold_start status when no v1
        // rows exist. Used by the Obsidian dashboard and topology-exploration
        // boredom goals to verify the substrate is making exploration progress.
        'topologyCoverage',
        // mcpTool: discovery-to-tools bridge. Activity-api currently exposes
        // its write surface through *_write impulse shapes (the preferred
        // dispatch path per docs/specs/discovery-to-tools-bridge.md
        // § "Relationship to impulse-write resolver"), not as MCP tools.
        // The resolver is still wired so consumers can fan out to activity-api
        // without 4xx-ing; it returns an empty tool list. See impulses.ts.
        'mcpTool',
        // discoverByShapesQuery: pure-vessel shape
        // wrapping POST /v2/activities/discover-by-shapes. Pointer fields
        // (required_shapes, mode, output_shapes, current_shapes, limit,
        // predecessor_activity_id) feed the same shared helper as the REST
        // route. Meta-activities reach this through the generic `impulse-resolve`
        // resolver in minibob — no source changes in the integrating vessel.
        'discoverByShapesQuery',
        'goal_verification_label',
        'goal_verification_label_write',
        // Semantic-context shapes (2026-05-01): permissive search over the
        // template registry, execution traces, and tool-argument patterns.
        // Backing the improvise / cold-start path: even non-exact matches
        // are surfaced and the consuming activity ranks them. No hard shape
        // filtering — declared output_shapes contribute as a soft boost.
        'activity_search',
        'trace_search',
        'tool_pattern_search',
        // Write/mutation shapes — advertised so vessel-discovery routes
        // load_impulse(*_write) calls here via REST instead of MCP.
        // Each shape has a matching case in src/routes/impulses.ts.
        'activityExecutionTrace_write',
        'activityFeedback_write',
        'activityComposition_write',
        'activityTemplate_write',
        'activityVariant_write',
        'impulseRelevance_write',
        'toolUsage_write',
        'toolArgumentPattern_write',
        'executionSequences_write',
        'shapeScore_write',
        'shapeGapResolution_write',
        'similarState_write',
        'goalSeeking_write',
        'execution_write',
        'compositionEdge_write',
        'goal_verification_label_write',
        // Admin/destructive shapes (admin scope required at route level)
        'activityTemplate_update',
        'activityTemplate_deprecate',
        'activityExecutionTrace_delete',
        // Test-audit loop (OpenSpec 2026-05-18-test-audit-loop, Phase A).
        // Four impulse shapes plus matching `_write` resolvers. Read handlers
        // do org-scoped queries against the new tables in migration 131;
        // write handlers persist via executeAsAuth root-credentials path so
        // SCHEMAFULL PERMISSIONS apply uniformly across API-key and JWT auth.
        // The accompanying meta-activities (audit-test-report,
        // run-sensitivity-probe, debug-failing-audit) live in minibob's
        // embedded-templates and dispatch through the standard
        // lifecycle:execution:succeeded subscription path.
        'test_registration',
        'test_registration_write',
        // test_report is the OUTPUT of a test run (consumed by audit-test-report
        // as input). The audit-loop spec §A.1 describes audits OVER test_report
        // impulses; the validation/scripts/test-forge-goal-completion.ts runner
        // (and grandfathered tests in Phase F) post to `test_report_write` to
        // persist their outcomes. Treated as a first-class shape alongside the
        // four originally enumerated in Phase A.
        'test_report',
        'test_report_write',
        'test_audit_report',
        'test_audit_report_write',
        'sensitivity_evidence',
        'sensitivity_evidence_write',
        'code_modification_proposal',
        'code_modification_proposal_write',
        'db_admin',
      ],
      // RESOLVER-DESCRIPTION ADVERTISEMENT (2026-06-28). One concise line per
      // DATA/REPORT resolver: what it produces + when to use it. Written ONCE
      // here by the vessel that owns these resolvers (NOT in the planner).
      // Discovery merges this across vessels and exposes it at
      // GET /registry/shape-descriptions; author_composed_capability composes
      // report/analysis chains from these descriptions with no hand-written hint.
      // Only keys also present in `shapes` above are honoured (stray keys ignored).
      shapeDescriptions: {
        traceAggregateReport:
          "Already-aggregated {key,value} rows computed in the database: failure/success/total counts or cost sums, grouped by activity template, status, or variant over a time window, sorted highest-first. THE direct answer to count/ranking/total/sum report goals — fast (~1s), no raw rows shipped. Config: group_by (activity_id|status|variant_id), metric (failure_count|success_count|count|cost_sum), window_hours, limit, order.",
        activityTemplatesByMetrics:
          "Activity templates filtered/ordered by performance metrics (Thompson posterior, success rate, execution count). Use for 'best/worst performing templates', 'top templates by success rate', or weak-family detection goals.",
        variantMetricsSummary:
          "Per-variant Thompson Sampling posteriors: alpha, beta, sample_count, success_count, failure_count for a given activity variant. Use to report a variant's learned win-rate or compare variants in a family.",
        compositionSuccess:
          "Composition-edge success statistics: for a producer→consumer shape edge, how often the composed execution succeeded. Use for 'which compositions/chains reliably work' or composition-health report goals.",
        templateAuditReport:
          "Per-template deficiency report: missing shapes, weak descriptions, all-LLM task graphs, hardcoded URLs, alias-cluster proposals. Use for 'audit template quality' or 'which templates are deficient' goals.",
        executionTraceWithSignatures:
          "Raw hydrated execution traces with per-task pointer/shape signatures and an impulses-by-id map. SLOW + load-fragile over the large trace table — use ONLY when the goal needs PER-TRACE detail an aggregate cannot give, never for counts/rankings (use traceAggregateReport for those). Config: limit (capped ~200), since, activity_template_id, success_only.",
        executionTraceList:
          "Paginated list of recent execution traces (id, activity_id, status, duration) for browse/inspect. Use for 'list recent executions' or 'show the last N runs' goals, not for aggregation.",
        executionTraces:
          "Query-able slice of execution-trace rows with filters. Use when a goal needs a filtered set of individual traces rather than an aggregate.",
        impulseRelevance:
          "Per-impulse relevance scores and failure counters learned from traces. Use for 'which impulses are most/least relevant' or impulse-quality report goals.",
      },
    },
  };
}

export const config = loadConfig();

/**
 * Singleton accessor for the loaded config. Handlers that prefer a function
 * form (and tests that need to stub config in isolation) should call this
 * instead of importing the `config` const directly. Currently a pass-through
 * to the module-level singleton; reserved as the single insertion point if
 * we ever add per-request config overrides (e.g. tenant-scoped flags).
 *
 * Used by Phase B handlers (OpenSpec
 * activity-api-account-id-migration-2026-04-28) to consult
 * `auth.accountIdRequired` per request.
 */
export function getConfig(): Config {
  return config;
}
