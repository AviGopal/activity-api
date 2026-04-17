/**
 * Discovery Vessel Client
 *
 * Manages registration, heartbeat, and deregistration with discovery-vessel.
 * Implements retry logic with exponential backoff and graceful degradation.
 */

import { config } from '../config';
import { logger } from '../utils/logger';
import packageJson from '../../package.json';

interface VesselRegistration {
  vesselId: string;
  vesselName: string;
  version: string;
  endpoint: string;
  shapes: string[];
  protocol?: string;
  orgId?: string;
  metadata?: Record<string, unknown>;
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
      const registration: VesselRegistration = {
        vesselId: config.discovery.vesselId,
        vesselName: 'metabob-activity-api',
        version: packageJson.version,
        endpoint: this.getEndpoint(),
        shapes: config.discovery.shapes,
        protocol: 'http',
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

      // If heartbeat fails, vessel may be considered expired
      // Attempt re-registration on next cycle
      this.registered = false;
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
        const options: RequestInit = {
          method,
          headers: {
            'Content-Type': 'application/json',
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
}

// Export singleton instance
export const discoveryClient = DiscoveryClient.getInstance();
