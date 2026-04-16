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
      jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
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
      shapes: [
        'activityExecutionTrace',
        'activityTemplate',
        'activityMetrics',
        'activityCompositionGraph',
        'impulseRelevanceMetrics',
        'toolUsagePatterns',
        'executionSequences',
      ],
    },
  };
}

export const config = loadConfig();
