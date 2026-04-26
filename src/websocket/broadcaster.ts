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
  private eventSequence: number = 0;
  private eventHistory: WebSocketMessage[] = [];
  private readonly MAX_HISTORY_SIZE = 1000;  // Keep last 1000 events for catchup

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
   * Automatically assigns sequence number and stores in history for catchup
   */
  emit(message: WebSocketMessage): void {
    // Assign sequence number for fine-grained events
    if (
      message.type === 'task.started' ||
      message.type === 'task.completed' ||
      message.type === 'tool.call' ||
      message.type === 'impulse.resolved'
    ) {
      message.sequence = ++this.eventSequence;

      // Store in history for catchup protocol
      this.eventHistory.push(message);

      // Trim history if it exceeds max size
      if (this.eventHistory.length > this.MAX_HISTORY_SIZE) {
        this.eventHistory.shift();
      }
    }

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
      sequence: message.sequence,
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

  /**
   * Send catchup events to a client that reconnected
   * Returns events with sequence number > lastSeenSequence
   */
  sendCatchup(ws: ServerWebSocket<WebSocketData>, lastSeenSequence: number): number {
    const missedEvents = this.eventHistory.filter(
      event => event.sequence && event.sequence > lastSeenSequence
    );

    let sentCount = 0;
    for (const event of missedEvents) {
      try {
        ws.send(JSON.stringify(event));
        sentCount++;
      } catch (error: any) {
        logger.error('[WebSocket] Failed to send catchup event', {
          error: error.message,
          sequence: event.sequence,
        });
        break;  // Stop sending if client can't receive
      }
    }

    logger.info('[WebSocket] Catchup complete', {
      lastSeenSequence,
      currentSequence: this.eventSequence,
      missedCount: missedEvents.length,
      sentCount,
    });

    return sentCount;
  }

  /**
   * Get current event sequence number
   */
  getCurrentSequence(): number {
    return this.eventSequence;
  }
}

// Singleton instance
export const broadcaster = new WebSocketBroadcaster();
