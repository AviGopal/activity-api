/**
 * WebSocket Broadcaster
 * 
 * Singleton for broadcasting events to all connected WebSocket clients.
 * Manages client connections and provides event emission API.
 * 
 * Architecture:
 * - Maintains Set of active ServerWebSocket connections
 * - Broadcasts JSON messages to all clients
 * - Provides connection lifecycle management
 * - Thread-safe (single-threaded Bun runtime)
 */

import { ServerWebSocket } from 'bun';
import { logger } from '../utils/logger';
import type { WebSocketMessage } from './types';

interface WebSocketData {
  sessionId?: string;
  orgId?: string;
  authenticated: boolean;
}

class WebSocketBroadcaster {
  private clients: Set<ServerWebSocket<WebSocketData>> = new Set();

  /**
   * Add client to broadcaster
   */
  addClient(ws: ServerWebSocket<WebSocketData>): void {
    this.clients.add(ws);
    logger.info('[WebSocket] Client connected', {
      totalClients: this.clients.size,
      authenticated: ws.data?.authenticated || false,
    });
  }

  /**
   * Remove client from broadcaster
   */
  removeClient(ws: ServerWebSocket<WebSocketData>): void {
    this.clients.delete(ws);
    logger.info('[WebSocket] Client disconnected', {
      totalClients: this.clients.size,
    });
  }

  /**
   * Broadcast message to all connected clients
   */
  emit(message: WebSocketMessage): void {
    const payload = JSON.stringify(message);
    let successCount = 0;
    let failureCount = 0;

    for (const client of this.clients) {
      try {
        // Only send to authenticated clients
        if (client.data?.authenticated) {
          client.send(payload);
          successCount++;
        }
      } catch (error: any) {
        logger.error('[WebSocket] Failed to send message to client', {
          error: error.message,
        });
        failureCount++;
      }
    }

    logger.debug('[WebSocket] Broadcast complete', {
      messageType: message.type,
      successCount,
      failureCount,
      totalClients: this.clients.size,
    });
  }

  /**
   * Broadcast message to clients in specific session
   */
  emitToSession(message: WebSocketMessage, sessionId: string): void {
    const payload = JSON.stringify(message);
    let successCount = 0;

    for (const client of this.clients) {
      try {
        if (client.data?.authenticated && client.data?.sessionId === sessionId) {
          client.send(payload);
          successCount++;
        }
      } catch (error: any) {
        logger.error('[WebSocket] Failed to send message to client', {
          error: error.message,
          sessionId,
        });
      }
    }

    logger.debug('[WebSocket] Session broadcast complete', {
      messageType: message.type,
      sessionId,
      successCount,
    });
  }

  /**
   * Broadcast message to clients in specific organization
   */
  emitToOrg(message: WebSocketMessage, orgId: string): void {
    const payload = JSON.stringify(message);
    let successCount = 0;

    for (const client of this.clients) {
      try {
        if (client.data?.authenticated && client.data?.orgId === orgId) {
          client.send(payload);
          successCount++;
        }
      } catch (error: any) {
        logger.error('[WebSocket] Failed to send message to client', {
          error: error.message,
          orgId,
        });
      }
    }

    logger.debug('[WebSocket] Org broadcast complete', {
      messageType: message.type,
      orgId,
      successCount,
    });
  }

  /**
   * Get connected client count
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Get authenticated client count
   */
  getAuthenticatedClientCount(): number {
    let count = 0;
    for (const client of this.clients) {
      if (client.data?.authenticated) {
        count++;
      }
    }
    return count;
  }
}

// Singleton instance
export const broadcaster = new WebSocketBroadcaster();
