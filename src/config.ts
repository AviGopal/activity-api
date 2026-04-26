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
        // discoverByShapesQuery (F-6 corrected, 2026-04-26): pure-vessel shape
        // wrapping POST /v2/activities/discover-by-shapes. Pointer fields
        // (required_shapes, mode, output_shapes, current_shapes, limit,
        // predecessor_activity_id) feed the same shared helper as the REST
        // route. Meta-activities reach this through the generic `impulse-resolve`
        // resolver in minibob — no source changes in the integrating vessel.
        'discoverByShapesQuery',
      ],
    },
  };
}

export const config = loadConfig();
