/**
 * Discovery Vessel Client
 *
 * Manages registration, heartbeat, and deregistration with discovery-vessel.
 * Implements retry logic with exponential backoff and graceful degradation.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import packageJson from '../../package.json';

interface VesselRegistration {
  vesselId: string;
  vesselName: string;
  version: string;
  endpoint: string;
  shapes: string[];
  /** Per-shape one-line descriptions (resolver-DESCRIPTION advertisement,
   *  2026-06-28). Optional; discovery ignores keys not in `shapes`. */
  shape_descriptions?: Record<string, string>;
  protocol?: string;
  orgId?: string;
  metadata?: Record<string, unknown>;
  // Wave 1 resolver contract (see super-repo CLAUDE.md + Wave 1A)
  resolve_endpoint?: string;
  resolve_request_format?: 'pointer' | 'shape' | 'custom';
  auth_scheme?: 'ApiKey' | 'Bearer' | 'None';
  resolve_timeout_ms?: number;
  // Auth token source (Wave A3, 2026-04-23, forward-mode only). See
  // super-repo `docs/specs/auth-token-source-field.md`. Activity-api
  // tenants by `$auth.org_id` from the caller's service identity, so
  // caller_identity is correct.
  auth_token_source?: 'caller_identity' | 'user_identity' | 'service_identity' | 'no_token';
  auth_delegation_mode?: 'forward' | 'mint' | 'none';
}

interface RegisterResponse {
  success: boolean;
  vesselId: string;
  expiresAt: number;
}

interface HeartbeatResponse {
  success: boolean;
  nextHeartbeatMs: number;
}

interface VesselMetrics {
  executionsCompleted?: number;
  errorRate?: number;
  avgLatencyMs?: number;
}

export class DiscoveryClient {
  private static instance: DiscoveryClient | null = null;
  private heartbeatTimer: Timer | null = null;
  private registered: boolean = false;
  private registrationAttempts: number = 0;
  private lastError: string | null = null;
  private metrics: VesselMetrics = {
    executionsCompleted: 0,
    errorRate: 0,
    avgLatencyMs: 0,
  };

  private constructor() {}

  static getInstance(): DiscoveryClient {
    if (!DiscoveryClient.instance) {
      DiscoveryClient.instance = new DiscoveryClient();
    }
    return DiscoveryClient.instance;
  }

  /**
   * Check if discovery integration is enabled
   */
  isEnabled(): boolean {
    return config.discovery.enabled;
  }

  /**
   * Check if vessel is currently registered
   */
  isRegistered(): boolean {
    return this.registered;
  }

  /**
   * Get last error message (for debugging)
   */
  getLastError(): string | null {
    return this.lastError;
  }

  /**
   * Update execution metrics
   */
  updateMetrics(metrics: Partial<VesselMetrics>): void {
    this.metrics = { ...this.metrics, ...metrics };
  }

  /**
   * Register this vessel with discovery-vessel
   */
  async register(): Promise<boolean> {
    if (!this.isEnabled()) {
      logger.debug('[Discovery] Registration skipped (disabled)');
      return false;
    }

    this.registrationAttempts++;

    try {
      // Phase 23 task 3.1-3.2: run shape-dispatch agreement check and filter
      // unhandled shapes from the registration payload.
      const { unhandledAdvertised, orphanHandlers } = this.checkShapeDispatchAgreement();
      if (unhandledAdvertised.length > 0) {
        logger.error('[Discovery] Shape-dispatch agreement violation: advertised shapes missing dispatch handlers', {
          validator_id: 'shape-dispatch-agreement',
          unhandledAdvertised,
        });
      }
      if (orphanHandlers.length > 0) {
        logger.warn('[Discovery] Shape-dispatch agreement: dispatch handlers not advertised', {
          validator_id: 'shape-dispatch-agreement',
          orphanHandlers,
        });
      }
      // TODO (task 3.3): emit failure_mode.type="verifier_negative" trace when
      // unhandledAdvertised.length > 0; debounce by (vessel_id, shape, direction).
      const safeShapes = unhandledAdvertised.length > 0
        ? config.discovery.shapes.filter(s => !unhandledAdvertised.includes(s))
        : config.discovery.shapes;

      const registration: VesselRegistration = {
        vesselId: config.discovery.vesselId,
        vesselName: 'metabob-activity-api',
        version: packageJson.version,
        endpoint: this.getEndpoint(),
        shapes: safeShapes,
        // Resolver-DESCRIPTION advertisement (2026-06-28): per-shape one-liners
        // so a decomposition planner can match this vessel's data resolvers from
        // their descriptions alone. Optional/backward-compat; discovery ignores
        // descriptions for shapes not in `shapes`.
        shape_descriptions: config.discovery.shapeDescriptions,
        protocol: 'http',
        // Wave 1 resolver contract — tells consumers (e.g. minibob's generic
        // resolver) how to dispatch impulse resolution requests against this
        // vessel without hardcoded knowledge. Dispatched by src/routes/impulses.ts.
        resolve_endpoint: '/v2/impulses/resolve',
        resolve_request_format: 'pointer',
        auth_scheme: 'ApiKey',
        resolve_timeout_ms: 10000,
        // Auth token source (Wave A3, 2026-04-23). Activity-api tenants by
        // `$auth.org_id` from the caller's service identity; caller_identity
        // is correct. Forward-mode delegation default applies — harmless
        // for caller_identity vessels.
        auth_token_source: 'caller_identity',
        auth_delegation_mode: 'forward',
        metadata: {
          environment: this.detectEnvironment(),
          podId: process.env.HOSTNAME || 'unknown',
          port: config.port,
        },
      };

      logger.info('[Discovery] Registering vessel', {
        vesselId: registration.vesselId,
        endpoint: registration.endpoint,
        shapes: registration.shapes,
      });

      const response = await this.retryRequest<RegisterResponse>(
        'POST',
        '/register',
        registration
      );

      if (response.success) {
        this.registered = true;
        this.registrationAttempts = 0;
        this.lastError = null;

        logger.info('[Discovery] ✓ Vessel registered successfully', {
          vesselId: response.vesselId,
          expiresAt: new Date(response.expiresAt).toISOString(),
        });

        return true;
      } else {
        throw new Error('Registration failed: success=false');
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.lastError = errorMsg;

      logger.warn('[Discovery] ✗ Registration failed', {
        attempt: this.registrationAttempts,
        error: errorMsg,
        willRetry: this.registrationAttempts < config.discovery.retryAttempts,
      });

      // Graceful degradation: continue operating without discovery
      this.registered = false;
      return false;
    }
  }

  /**
   * Send heartbeat to discovery-vessel
   */
  async sendHeartbeat(): Promise<boolean> {
    if (!this.isEnabled() || !this.registered) {
      return false;
    }

    try {
      const request = {
        vesselId: config.discovery.vesselId,
        metrics: this.metrics,
      };

      const response = await this.retryRequest<HeartbeatResponse>(
        'POST',
        '/heartbeat',
        request
      );

      if (response.success) {
        logger.debug('[Discovery] ✓ Heartbeat sent', {
          nextHeartbeatMs: response.nextHeartbeatMs,
        });
        return true;
      } else {
        throw new Error('Heartbeat failed: success=false');
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.lastError = errorMsg;

      logger.warn('[Discovery] ✗ Heartbeat failed', {
        error: errorMsg,
        registered: this.registered,
      });

      // If heartbeat fails, vessel may be considered expired.
      // Re-register IMMEDIATELY (canonical DiscoveryRegistrationLoop
      // semantics): a failed heartbeat usually means discovery-vessel
      // restarted and lost its in-memory record — deferring to the next
      // interval tick leaves this vessel unroutable for up to a full
      // heartbeatIntervalMs.
      this.registered = false;
      try {
        await this.register();
      } catch {
        // next interval tick retries via startHeartbeatManager
      }
      return false;
    }
  }

  /**
   * Deregister this vessel from discovery-vessel
   */
  async deregister(): Promise<boolean> {
    if (!this.isEnabled() || !this.registered) {
      return false;
    }

    try {
      const vesselId = config.discovery.vesselId;

      logger.info('[Discovery] Deregistering vessel', { vesselId });

      await this.retryRequest<{ success: boolean }>(
        'DELETE',
        `/vessels/${vesselId}`,
        undefined
      );

      this.registered = false;
      this.lastError = null;

      logger.info('[Discovery] ✓ Vessel deregistered successfully');
      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.lastError = errorMsg;

      logger.warn('[Discovery] ✗ Deregistration failed', {
        error: errorMsg,
      });

      return false;
    }
  }

  /**
   * Start heartbeat manager (periodic heartbeats)
   */
  startHeartbeatManager(): void {
    if (!this.isEnabled()) {
      logger.debug('[Discovery] Heartbeat manager not started (disabled)');
      return;
    }

    if (this.heartbeatTimer) {
      logger.warn('[Discovery] Heartbeat manager already running');
      return;
    }

    logger.info('[Discovery] Starting heartbeat manager', {
      intervalMs: config.discovery.heartbeatIntervalMs,
    });

    this.heartbeatTimer = setInterval(async () => {
      // If not registered, attempt registration
      if (!this.registered) {
        await this.register();
      } else {
        // Send heartbeat
        await this.sendHeartbeat();
      }
    }, config.discovery.heartbeatIntervalMs);
  }

  /**
   * Stop heartbeat manager
   */
  stopHeartbeatManager(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      logger.info('[Discovery] Heartbeat manager stopped');
    }
  }

  /**
   * Query vessels by shape capability
   */
  async discoverVesselsForShape(shape: string): Promise<{
    found: boolean;
    vessels: Array<{ vesselId: string; endpoint: string; shapes: string[] }>;
  }> {
    if (!this.isEnabled()) {
      logger.debug('[Discovery] Query skipped (disabled)');
      return { found: false, vessels: [] };
    }

    try {
      const response = await this.retryRequest<any>(
        'POST',
        '/resolve',
        { shape }
      );

      if (response.found && response.vessels && response.vessels.length > 0) {
        logger.debug('[Discovery] Found vessels for shape', {
          shape,
          count: response.vessels.length,
        });
        return {
          found: true,
          vessels: response.vessels,
        };
      } else {
        logger.debug('[Discovery] No vessels found for shape', { shape });
        return { found: false, vessels: [] };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.lastError = errorMsg;

      logger.warn('[Discovery] ✗ Query failed', {
        shape,
        error: errorMsg,
      });

      return { found: false, vessels: [] };
    }
  }

  /**
   * Gracefully shutdown (deregister and stop heartbeat)
   */
  async shutdown(): Promise<void> {
    logger.info('[Discovery] Shutting down discovery client');

    this.stopHeartbeatManager();
    await this.deregister();
  }

  /**
   * HTTP request with retry logic and exponential backoff
   */
  private async retryRequest<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${config.discovery.endpoint}${path}`;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= config.discovery.retryAttempts; attempt++) {
      try {
        const apiKey = process.env.METABOB_API_KEY || process.env.ACTIVITY_API_KEY;
        const options: RequestInit = {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}),
          },
        };

        if (body !== undefined) {
          options.body = JSON.stringify(body);
        }

        const response = await fetch(url, options);

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const result = await response.json();
        return result as T;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < config.discovery.retryAttempts) {
          const backoffMs = config.discovery.retryBackoffMs * Math.pow(2, attempt);
          logger.debug('[Discovery] Request failed, retrying', {
            attempt: attempt + 1,
            maxAttempts: config.discovery.retryAttempts,
            backoffMs,
            error: lastError.message,
          });

          await this.sleep(backoffMs);
        }
      }
    }

    throw lastError || new Error('Request failed after retries');
  }

  /**
   * Sleep for specified milliseconds
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get this vessel's external endpoint
   */
  private getEndpoint(): string {
    // Use explicit endpoint if configured
    if (process.env.VESSEL_ENDPOINT) {
      return process.env.VESSEL_ENDPOINT;
    }

    // In Kubernetes, construct from service name
    const namespace = process.env.SURREALDB_NAMESPACE || 'activity-system';
    const serviceName = process.env.SERVICE_NAME || 'metabob-activity-api';
    const port = config.port;

    return `http://${serviceName}.${namespace}.svc.cluster.local:${port}`;
  }

  /**
   * Detect deployment environment
   */
  private detectEnvironment(): 'k8s-cluster' | 'docker' | 'local' {
    if (process.env.KUBERNETES_SERVICE_HOST) {
      return 'k8s-cluster';
    } else if (process.env.DOCKER_CONTAINER) {
      return 'docker';
    } else {
      return 'local';
    }
  }

  /**
   * Check shape-dispatch agreement at startup (task 3.1-3.2, Phase 23).
   *
   * Diffs config.discovery.shapes against the switch cases in
   * src/routes/impulses.ts. Returns shapes that are advertised but have no
   * handler (unhandledAdvertised) and handlers with no advertised shape
   * (orphanHandlers, excluding @shape-dispatch:private cases).
   *
   * Inline logic mirrors packages/shape-dispatch-check/check.ts so this works
   * inside the Docker image without the super-repo present.
   */
  private checkShapeDispatchAgreement(): {
    unhandledAdvertised: string[];
    orphanHandlers: string[];
  } {
    try {
      const vesselRoot = resolve(import.meta.dir, '..', '..');
      const configPath = join(vesselRoot, 'src', 'config.ts');
      const dispatchPath = join(vesselRoot, 'src', 'routes', 'impulses.ts');

      if (!existsSync(configPath) || !existsSync(dispatchPath)) {
        return { unhandledAdvertised: [], orphanHandlers: [] };
      }

      const configSrc = readFileSync(configPath, 'utf8');
      const dispatchSrc = readFileSync(dispatchPath, 'utf8');

      // Extract advertised shapes (mirrors extractAdvertisedShapes in check.ts)
      const advertised = new Set<string>();
      const shapeArrayPattern = /(?:shapes|advertised_shapes|ADVERTISED_SHAPES)\s*[:=]\s*\[/;
      let inArray = false;
      let depth = 0;
      for (const line of configSrc.split('\n')) {
        if (!inArray) {
          if (shapeArrayPattern.test(line)) {
            inArray = true;
            for (const ch of line) {
              if (ch === '[') depth++;
              else if (ch === ']') depth--;
            }
            if (depth <= 0) inArray = false;
            for (const m of line.matchAll(/['"]([^'"]+)['"]/g)) advertised.add(m[1]);
          }
          continue;
        }
        let nd = depth;
        for (const ch of line) {
          if (ch === '[') nd++;
          else if (ch === ']') nd--;
        }
        if (nd <= 0) {
          const seg = line.slice(0, line.lastIndexOf(']') >= 0 ? line.lastIndexOf(']') : line.length);
          for (const m of seg.matchAll(/['"]([^'"]+)['"]/g)) advertised.add(m[1]);
          inArray = false;
          depth = 0;
        } else {
          depth = nd;
          const stripped = line.replace(/\/\/.*$/, '');
          for (const m of stripped.matchAll(/['"]([^'"]+)['"]/g)) advertised.add(m[1]);
        }
      }

      // Extract dispatch cases (mirrors extractDispatchCases in check.ts)
      const dispatched = new Map<string, boolean>(); // literal → isPrivate
      const dlines = dispatchSrc.split('\n');
      for (let i = 0; i < dlines.length; i++) {
        const m = /^\s*case\s+(['"])([^'"]+)\1\s*:/.exec(dlines[i]);
        if (!m) continue;
        let isPrivate = false;
        for (let j = i - 1; j >= 0; j--) {
          const prev = dlines[j].trim();
          if (prev === '') continue;
          if (prev.includes('@shape-dispatch:private')) { isPrivate = true; break; }
          if (/^case\s+['"]/.test(prev)) continue;
          break;
        }
        dispatched.set(m[2], isPrivate);
      }

      const unhandledAdvertised = [...advertised].filter(s => !dispatched.has(s));
      const orphanHandlers = [...dispatched.entries()]
        .filter(([, priv]) => !priv)
        .map(([s]) => s)
        .filter(s => !advertised.has(s));

      return { unhandledAdvertised, orphanHandlers };
    } catch {
      // Non-fatal: source files absent (compiled bundle) or parse error.
      return { unhandledAdvertised: [], orphanHandlers: [] };
    }
  }
}

// Export singleton instance
export const discoveryClient = DiscoveryClient.getInstance();
