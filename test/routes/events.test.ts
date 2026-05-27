import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import eventsRouter from '../../src/routes/events';
import { broadcaster } from '../../src/websocket/broadcaster';

// Helper: build a fresh Hono app with the events router mounted.
function makeApp(): Hono {
  const app = new Hono();
  app.route('/v2/events', eventsRouter);
  return app;
}

describe('POST /v2/events/publish', () => {
  let emittedMessages: any[] = [];
  let emitSpy: any;
  let emitToOrgSpy: any;
  let emitToSessionSpy: any;

  beforeEach(() => {
    emittedMessages = [];
    emitSpy = mock((m: any) => { emittedMessages.push({ scope: 'broadcast', message: m }); });
    emitToOrgSpy = mock((m: any, orgId: string) => { emittedMessages.push({ scope: 'org', orgId, message: m }); });
    emitToSessionSpy = mock((m: any, sessionId: string) => { emittedMessages.push({ scope: 'session', sessionId, message: m }); });
    broadcaster.emit = emitSpy;
    broadcaster.emitToOrg = emitToOrgSpy;
    broadcaster.emitToSession = emitToSessionSpy;
  });

  afterEach(() => {
    emittedMessages = [];
  });

  it('accepts a valid <source>.<noun>.<verb> event and broadcasts', async () => {
    const app = makeApp();
    const res = await app.request('/v2/events/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'lifecycle.task.pre_binding',
        source_vessel_id: 'goal-host-vessel',
        data: { executionId: 'exec_x', taskId: 'task_y' },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(true);
    expect(typeof body.ts).toBe('number');
    expect(emittedMessages).toHaveLength(1);
    expect(emittedMessages[0].scope).toBe('broadcast');
    expect(emittedMessages[0].message.type).toBe('lifecycle.task.pre_binding');
    expect(emittedMessages[0].message.data.source_vessel_id).toBe('goal-host-vessel');
    expect(emittedMessages[0].message.data.executionId).toBe('exec_x');
  });

  it('rejects malformed event type with 400 (single segment)', async () => {
    const app = makeApp();
    const res = await app.request('/v2/events/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'lifecycle', // only 1 segment
        source_vessel_id: 'x',
        data: {},
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.accepted).toBe(false);
    expect(emittedMessages).toHaveLength(0);
  });

  it('accepts 2-segment event types like vessel.registered', async () => {
    const app = makeApp();
    const res = await app.request('/v2/events/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'vessel.registered',
        source_vessel_id: 'discovery-vessel',
        data: { vessel_id: 'foo' },
      }),
    });
    expect(res.status).toBe(200);
    expect(emittedMessages).toHaveLength(1);
    expect(emittedMessages[0].message.type).toBe('vessel.registered');
  });

  it('rejects type with uppercase / hyphens with 400', async () => {
    const app = makeApp();
    const res = await app.request('/v2/events/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'Lifecycle.Task.PreBinding',
        source_vessel_id: 'x',
        data: {},
      }),
    });
    expect(res.status).toBe(400);
    expect(emittedMessages).toHaveLength(0);
  });

  it('broadcaster failure does NOT propagate (best-effort bus)', async () => {
    broadcaster.emit = mock(() => { throw new Error('broadcaster down'); });
    const app = makeApp();
    const res = await app.request('/v2/events/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'vessel.registered',
        source_vessel_id: 'discovery-vessel',
        data: { vessel_id: 'foo' },
      }),
    });
    // Producer sees 200 — event was accepted; fan-out hiccup is logged elsewhere.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(true);
  });

  it('session scope routes to emitToSession with target', async () => {
    const app = makeApp();
    const res = await app.request('/v2/events/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'lifecycle.task.completed',
        source_vessel_id: 'goal-host-vessel',
        scope: 'session',
        target: 'sess_abc',
        data: { taskId: 't' },
      }),
    });
    expect(res.status).toBe(200);
    expect(emittedMessages).toHaveLength(1);
    expect(emittedMessages[0].scope).toBe('session');
    expect(emittedMessages[0].sessionId).toBe('sess_abc');
  });

  it('session scope without target rejects with 400', async () => {
    const app = makeApp();
    const res = await app.request('/v2/events/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'lifecycle.task.completed',
        source_vessel_id: 'x',
        scope: 'session',
        data: {},
      }),
    });
    expect(res.status).toBe(400);
  });

  it('flattens data fields into emitted message data while preserving source_vessel_id', async () => {
    const app = makeApp();
    await app.request('/v2/events/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'vessel.registered',
        source_vessel_id: 'discovery-vessel',
        data: {
          vessel_id: 'development-vessel-local',
          shapes: ['shape_a', 'shape_b'],
          ttl_seconds: 300,
        },
      }),
    });
    expect(emittedMessages).toHaveLength(1);
    const msg = emittedMessages[0].message;
    expect(msg.type).toBe('vessel.registered');
    expect(msg.data.vessel_id).toBe('development-vessel-local');
    expect(msg.data.shapes).toEqual(['shape_a', 'shape_b']);
    expect(msg.data.ttl_seconds).toBe(300);
    expect(msg.data.source_vessel_id).toBe('discovery-vessel');
    expect(typeof msg.timestamp).toBe('string'); // ISO-8601
  });
});
