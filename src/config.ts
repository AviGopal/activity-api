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
  };
  
  // Redis
  redis: {
    url: string;
    ttl: {
      session: number;      // Session TTL in seconds
      template: number;     // Template cache TTL
      metrics: number;      // Metrics cache TTL
    };
  };
  
  // Security
  auth: {
    requireAuth: boolean;  // Set to false for development
  };
  
  // Logging
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logFormat: 'json' | 'text';
  
  // CORS
  cors: {
    origins: string[];
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

export function loadConfig(): Config {
  return {
    port: parseEnvInt('PORT', 8080),
    host: process.env.HOST || '0.0.0.0',
    
    surrealdb: {
      url: process.env.SURREALDB_URL || 'http://localhost:8000',
      namespace: process.env.SURREALDB_NAMESPACE || 'metabob',
      database: process.env.SURREALDB_DATABASE || 'learning_loop',
      username: process.env.SURREALDB_USERNAME || 'root',
      password: process.env.SURREALDB_PASSWORD || 'changeme',
    },
    
    redis: {
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      ttl: {
        session: parseEnvInt('REDIS_SESSION_TTL', 86400), // 24 hours
        template: parseEnvInt('REDIS_TEMPLATE_TTL', 3600), // 1 hour
        metrics: parseEnvInt('REDIS_METRICS_TTL', 300),    // 5 minutes
      },
    },
    
    auth: {
      requireAuth: parseEnvBool('REQUIRE_AUTH', false),
    },
    
    logLevel: (process.env.LOG_LEVEL || 'info') as Config['logLevel'],
    logFormat: (process.env.LOG_FORMAT || 'text') as Config['logFormat'],
    
    cors: {
      origins: process.env.CORS_ORIGINS?.split(',') || ['*'],
    },
  };
}

export const config = loadConfig();
