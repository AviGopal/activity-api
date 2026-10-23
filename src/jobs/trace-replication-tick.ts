/**
 * trace-replication-tick — pull-based intra-identity-group trace replication.
 *
 * Design (see project memory trace-sync-lockfree-priors): within one identity
 * group, activity-api instances converge their `execution` tables by each
 * PULLING peers' rows since a per-peer watermark and idempotently UPSERTing them
 * locally. One mechanism delivers BOTH ongoing convergence (new traces cross
 * within one interval) AND historical reconciliation (the anti-entropy backstop
 * drains the gap over successive ticks).
 *
 * - Peer discovery: discoverVesselsForShape('activityExecutionTrace'), filtered
 *   to libp2p peers (remote) other than self.
 * - Transport: the local federation-transport egress (POST :FED_HEALTH_PORT
 *   /egress/resolve) dials the peer over libp2p — no hardcoded URL, law-aligned
 *   (all cross-vessel transfer rides the transport).
 * - Read shape: executionReplicationPull (full lossless rows + provenance).
 * - Echo suppression: exclude_origin=<self> so an instance never re-imports what
 *   it authored (single-hop-fanout invariant); combined with idempotent UPSERT
 *   by record id, replication is loop-safe.
 * - Watermark: replication_state:<peer> row, advanced to max(executed_at) pulled.
 *
 * Advisory / non-throwing, like the other *-tick jobs. Root DB path (internal
 * plumbing, not tenant data).
 */

import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import { discoveryClient } from '../services/discovery-client';
import { config } from '../config';

const EGRESS_URL = `http://localhost:${process.env.FED_HEALTH_PORT || '8401'}/egress/resolve`;

// THE CALLER'S CREDENTIAL RIDES THE LOCAL TRANSPORT HOP AS A HEADER, NEVER IN THE POINTER.
// The peer's ingress admits a caller only by its own credential (executionReplicationPull is
// trust_group in federationShapePolicy) and the transport never lends the node's key, so a
// pull that crosses with none is refused. The local transport moves this request's
// Authorization header into the wire pointer itself and the far ingress strips it before any
// log or trace. This is the same key activity-api already presents to discovery
// (discovery-client), read at use time like there. EGRESS_URL is always the local transport.
function transportHopHeaders(): Record<string, string> {
  const apiKey = process.env.METABOB_API_KEY || process.env.ACTIVITY_API_KEY;
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}),
  };
}
// Read at use time, like ownSubstrateId below: frozen at module load, a tick loaded before the node identity
// was set would never send exclude_origin, and echo suppression would be off with nothing to show it.
const selfOrigin = (): string =>
  process.env.FED_SUBSTRATE_ID || process.env.SUBSTRATE_ID || '';
const PULL_LIMIT = Math.max(
  1,
  Math.min(2000, Number(process.env.REPLICATION_PULL_LIMIT || 200)),
);
const MAX_BATCHES_PER_PEER = Math.max(
  1,
  Number(process.env.REPLICATION_MAX_BATCHES || 5),
);
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

interface PeerVessel {
  vesselId: string;
  protocol?: string;
  libp2p_multiaddr?: string[];
}

function defaultSince(): string {
  return new Date(Date.now() - LOOKBACK_MS).toISOString();
}

async function getWatermark(peerId: string): Promise<string> {
  try {
    const rows = await surrealDB.query<{ last_pulled_at?: string }>(
      `SELECT last_pulled_at FROM type::thing('replication_state', $id)`,
      { id: peerId },
    );
    const w = Array.isArray(rows) && rows[0] ? rows[0].last_pulled_at : null;
    return typeof w === 'string' && w.length > 0 ? w : defaultSince();
  } catch {
    return defaultSince();
  }
}

async function setWatermark(peerId: string, ts: string): Promise<void> {
  try {
    await surrealDB.query(
      `UPSERT type::thing('replication_state', $id) SET
         peer_id = $id, last_pulled_at = $ts, updated_at = time::now()`,
      { id: peerId, ts },
    );
  } catch (err) {
    logger.warn('[Replication] watermark write failed (non-blocking)', {
      peerId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function bareExecutionId(rawId: unknown): string | null {
  if (rawId == null) return null;
  // JSON over the transport renders the record id as a string
  // ("execution:exec_x" or "execution:⟨exec-x⟩"); the JS client may render an
  // object { tb, id }. Normalize to the bare key.
  if (typeof rawId === 'string') {
    return rawId
      .replace(/^execution:/, '')
      .replace(/^⟨/, '')
      .replace(/⟩$/, '');
  }
  const obj = rawId as { id?: unknown };
  if (obj && obj.id != null) return String(obj.id);
  return String(rawId);
}

/** UPSERT one pulled execution row verbatim (idempotent by record id). */
// `execution` defines created_at/executed_at as datetime; over the transport
// they arrive as ISO strings, which fail the SCHEMAFULL type check on CONTENT.
// Coerce them to Date so the SurrealDB SDK encodes them as datetime.
const DATETIME_FIELDS = ['created_at', 'executed_at'] as const;

async function upsertRow(row: Record<string, unknown>): Promise<boolean> {
  const bid = bareExecutionId(row.id);
  if (!bid) return false;
  const { id: _drop, ...content } = row;
  for (const f of DATETIME_FIELDS) {
    if (typeof content[f] === 'string') {
      const d = new Date(content[f] as string);
      if (!Number.isNaN(d.getTime())) content[f] = d;
    }
  }
  try {
    await surrealDB.query(
      `UPSERT type::thing('execution', $bid) CONTENT $content`,
      { bid, content },
    );
    return true;
  } catch (err) {
    logger.warn('[Replication] row UPSERT failed (skipped)', {
      bid,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** An auth refusal carried INSIDE a transport envelope (the egress answered 200; the peer's resolve said no). Read from the
 *  answer's own structured code fields (the codes the fleet's auth layers emit), never from prose. */
export function isAuthRefusalBody(b: any): boolean {
  if (!b || typeof b !== 'object') return false;
  const inner = typeof b.value === 'string' ? (() => { try { return JSON.parse(b.value); } catch { return null; } })() : b.value ?? b;
  const codes = [b.code, b.error?.code, inner?.code, inner?.error?.code, inner?.failure_mode, b.status, inner?.status].filter((x) => typeof x === 'string' || typeof x === 'number');
  return codes.some((c) => c === 401 || c === 403 || c === 'INVALID_API_KEY' || c === 'UNAUTHORIZED' || c === 'unauthorized' || c === 'caller_credential_required');
}

async function pullFromPeer(peer: PeerVessel): Promise<{ pulled: number; stored: number; refused?: 'unauthorized' }> {
  const target = peer.libp2p_multiaddr?.[0];
  if (!target) return { pulled: 0, stored: 0 };

  let since = await getWatermark(peer.vesselId);
  let pulledTotal = 0;
  let storedTotal = 0;

  for (let batch = 0; batch < MAX_BATCHES_PER_PEER; batch++) {
    let rows: Record<string, unknown>[] = [];
    try {
      const resp = await fetch(EGRESS_URL, {
        method: 'POST',
        headers: transportHopHeaders(),
        body: JSON.stringify({
          target,
          pointer: {
            type: 'executionReplicationPull',
            since,
            limit: PULL_LIMIT,
            exclude_origin: selfOrigin() || undefined,
          },
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!resp.ok) {
        // An AUTH refusal is the peer authority not knowing this node's credential (cross-authority): logged as such,
        // as evidence for cross-authority-peer-dials-present-a-credential-the-peer-authority-never-issued.
        if (resp.status === 401 || resp.status === 403) {
          logger.warn('[Replication] peer refused this node\'s credential (cross-authority); skipped this tick', { peer: peer.vesselId, status: resp.status });
          return { pulled: 0, stored: 0, refused: 'unauthorized' };
        }
        logger.warn('[Replication] egress resolve non-OK', {
          peer: peer.vesselId,
          status: resp.status,
        });
        break;
      }
      const data: any = await resp.json();
      if (isAuthRefusalBody(data?.content ?? data)) {
        logger.warn('[Replication] peer refused this node\'s credential (cross-authority); skipped this tick', { peer: peer.vesselId });
        return { pulled: 0, stored: 0, refused: 'unauthorized' };
      }
      // Transport envelope: { content: { value: "<json string>" } } (value is
      // the stringified resolve payload); tolerate object/plain forms too.
      let payload: any = data?.content ?? data;
      if (payload && typeof payload.value === 'string') {
        try {
          payload = JSON.parse(payload.value);
        } catch {
          /* leave payload */
        }
      } else if (payload && payload.value && typeof payload.value === 'object') {
        payload = payload.value;
      }
      rows =
        (payload?.rows as Record<string, unknown>[]) ??
        (payload?.data?.rows as Record<string, unknown>[]) ??
        [];
    } catch (err) {
      logger.warn('[Replication] pull batch failed', {
        peer: peer.vesselId,
        error: err instanceof Error ? err.message : String(err),
      });
      break;
    }

    if (!Array.isArray(rows) || rows.length === 0) break;

    // Rows come back ORDER BY executed_at ASC. Advance the watermark ONLY over
    // the contiguous prefix of successfully-stored rows: if a row fails to store
    // (transient DB error, contention), stop advancing so it is re-pulled next
    // tick rather than silently skipped. Advancing on *pulled* (not *stored*)
    // rows would permanently drop any row whose UPSERT failed.
    let contiguousTs = since;
    let brokeOnFailure = false;
    for (const row of rows) {
      const ok = await upsertRow(row);
      if (!ok) {
        brokeOnFailure = true;
        break;
      }
      storedTotal++;
      const ts = row.executed_at;
      if (typeof ts === 'string' && ts > contiguousTs) contiguousTs = ts;
    }
    pulledTotal += rows.length;

    const advanced = contiguousTs > since;
    if (advanced) {
      since = contiguousTs;
      await setWatermark(peer.vesselId, since);
    }

    // Stop this peer's loop if a row failed (re-pull from the watermark next
    // tick) or if we could not advance at all (avoid a hot loop on a stuck row).
    if (brokeOnFailure || !advanced) break;
    if (rows.length < PULL_LIMIT) break; // drained this peer for now

    // Yield briefly between batches so the historical drain does not starve
    // live trace ingest on the shared SurrealDB.
    await new Promise((r) => setTimeout(r, 250));
  }

  return { pulled: pulledTotal, stored: storedTotal };
}

export async function runTraceReplicationTick(): Promise<void> {
  try {
    if (!discoveryClient.isEnabled()) return;
    const { vessels } = await discoveryClient.discoverVesselsForShape(
      'activityExecutionTrace',
    );
    const selfId = config.discovery.vesselId;
    const ownSubstrateId = process.env.FED_SUBSTRATE_ID || '';
    const peers = (vessels as unknown as PeerVessel[]).filter(
      (v) =>
        v.vesselId !== selfId && (!ownSubstrateId || !v.vesselId.endsWith(`@${ownSubstrateId}`)) &&
        v.protocol === 'libp2p' &&
        Array.isArray(v.libp2p_multiaddr) &&
        v.libp2p_multiaddr.length > 0 &&
        // REACHABILITY (d): discovery stamps a libp2p row egress_unreachable while THIS node's federation egress is
        // not live (masked, stopped, refusing); every pull of it would be refused at the egress. Skipped, counted.
        !(v as unknown as { egress_unreachable?: unknown }).egress_unreachable,
    );
    const stamped = (vessels as unknown as Array<{ egress_unreachable?: unknown }>).filter((v) => v.egress_unreachable === true).length;
    if (stamped > 0) logger.info('[Replication] skipped peers behind an unreachable local egress', { stamped });
    logger.info('[Replication] tick: discovered peers', {
      total: vessels.length,
      libp2pPeers: peers.length,
      self: selfId,
    });
    if (peers.length === 0) {
      return;
    }
    for (const peer of peers) {
      const { pulled, stored } = await pullFromPeer(peer);
      logger.info('[Replication] peer pull result', {
        peer: peer.vesselId,
        pulled,
        stored,
      });
    }
  } catch (err) {
    logger.warn('[Replication] tick failed (non-blocking)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
