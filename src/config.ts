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
        // goal_verification_label_write is the entry point; read-side not yet
        // exposed (no dispatch case). Removed from advertised shapes until
        // a read resolver is added — shape-dispatch-agreement check would flag it.
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
      ],
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
