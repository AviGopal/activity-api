/**
 * goal_verification_label_write: the oracle corpus's one writer.
 *
 * Moved out of routes/impulses.ts so this handler, the only place a goal verification label is
 * created, is one file that can be reviewed and closed on its own. impulses.ts still owns the
 * route: its `goal_verification_label_write` case calls resolveGoalVerificationLabelWrite with the
 * request's JwtAuthContext and its own executeAsAuth, and turns the result into the response.
 *
 * The SQL runner is passed in rather than imported, because executeAsAuth (the API-key
 * root-credentials fallback vs. queryWithAuth choice) is private to impulses.ts.
 */

import type { ImpulseResolveResponse } from '../models/schemas';
import type { JwtAuthContext } from '../middleware/jwtAuth';
import { logger } from '../utils/logger';

/** The query runner impulses.ts hands in (its executeAsAuth). */
export type ExecuteAsAuth = <T>(jwtAuth: JwtAuthContext, sql: string, params: Record<string, unknown>) => Promise<T[]>;

/** What the route sends back: the HTTP status and the response body. */
export interface LabelWriteResult {
  status: 200 | 400 | 401 | 403 | 500;
  body: ImpulseResolveResponse;
}

/**
 * WHO MAY WRITE A HUMAN VERDICT.
 *
 * goal-host's oracle-label consumer turns a `labeler:"human"` row into a reach override and files a
 * `source:"human_reported"` disagreement gap. Until this check, `labeler` was whatever the caller
 * sent, and any authenticated key could send "human": a goal walk resolving this shape with
 * goal-host's own fleet key passes requireAuthenticated exactly as the operator does. Measured by
 * deployment: the cockpit key and the node keys are different keys of the SAME principal (same
 * user_id and org, role "user", scopes [read, write]). Only the SCOPES the credential was issued
 * with separate an operator from the walk, so that is the one thing this reads.
 *
 * isHumanVerdictPrincipal reads exactly these JwtAuthContext fields, all set by the auth middleware
 * (middleware/jwtAuth.ts) from the server-side validation of the request's credential, never from
 * the pointer:
 *   - scopes: identity-vessel's validation answer for an ApiKey (its api_key row's scopes), or the
 *     verified JWT's `$auth.scopes ?? $token.scopes`. A human verdict needs HUMAN_VERDICT_SCOPE, or
 *     ADMIN_SCOPE as the interim fallback until a verdict-scoped operator key is issued.
 *   - keyId: the verdict must be attributable, so a credential without a server-derived key id is
 *     refused (it is what labeled_by_principal names).
 *   - obo: a caller that arrived through a federation ingress with an on-behalf-of token is never a
 *     human verdict here. identity's obo exchange strips "admin" but not other scopes, and a peer
 *     node's grant is not the operator at this node. Revisit if cross-node operator feedback is
 *     wanted.
 * It does NOT read role or userId: both are identical for the operator and the walk (deployment,
 * above). There is no key-id allow-list and no env or constant gate (law 1): who holds the verdict
 * scope is decided where keys are issued (identity-vessel), and changes there take effect here.
 * Unknown, missing or malformed means NOT a human-verdict principal (fail closed).
 *
 * Non-human labelers (automated, deterministic) are unaffected: any authenticated caller may still
 * write them, as before.
 */
export const HUMAN_VERDICT_SCOPE = 'verdict:human';
export const ADMIN_SCOPE = 'admin';

export function isHumanVerdictPrincipal(ctx: JwtAuthContext | null | undefined): boolean {
  if (!ctx) return false;
  if (ctx.obo) return false;
  if (typeof ctx.keyId !== 'string' || ctx.keyId.trim().length === 0) return false;
  const scopes = Array.isArray(ctx.scopes) ? ctx.scopes : [];
  return scopes.includes(HUMAN_VERDICT_SCOPE) || scopes.includes(ADMIN_SCOPE);
}

/**
 * The principal stamped on a human label, built from the server-validated context only. A
 * `labeled_by_principal` the caller puts on the pointer is never read: the CREATE names its fields
 * explicitly and binds this object. goal-host's consumer acts on a human label only when this stamp
 * carries the verdict scope (or admin).
 */
export interface LabeledByPrincipal {
  key_id: string;
  auth_type: string;
  scopes: string[];
}

export function labeledByPrincipal(ctx: JwtAuthContext): LabeledByPrincipal {
  return {
    key_id: String(ctx.keyId),
    auth_type: ctx.authType ?? 'unknown',
    scopes: (Array.isArray(ctx.scopes) ? ctx.scopes : []).map(String),
  };
}

export async function resolveGoalVerificationLabelWrite(
  jwtAuthOrNull: JwtAuthContext | null | undefined,
  pointer: Record<string, unknown>,
  executeAsAuth: ExecuteAsAuth,
): Promise<LabelWriteResult> {
  if (!jwtAuthOrNull) {
    return { status: 401, body: { success: false, error: 'Authentication required for destructive operations' } as ImpulseResolveResponse };
  }
  const jwtAuth = jwtAuthOrNull;

  const gvlPointer = pointer as {
    goal?: string;
    execution_id?: string;
    activity_id?: string;
    verdict?: string;
    confidence?: number;
    notes?: string;
    labeler?: string;
  };

  if (!gvlPointer.goal || !gvlPointer.execution_id || !gvlPointer.activity_id ||
      !gvlPointer.verdict || gvlPointer.confidence === undefined || !gvlPointer.labeler) {
    return { status: 400, body: {
      success: false,
      error: 'goal, execution_id, activity_id, verdict, confidence, and labeler are required for goal_verification_label_write',
    } as ImpulseResolveResponse };
  }

  const validVerdicts = ['achieved', 'not_achieved', 'partial'];
  if (!validVerdicts.includes(gvlPointer.verdict)) {
    return { status: 400, body: {
      success: false,
      error: `verdict must be one of: ${validVerdicts.join(', ')}`,
    } as ImpulseResolveResponse };
  }

  const validLabelers = ['human', 'automated', 'deterministic'];
  if (!validLabelers.includes(gvlPointer.labeler)) {
    return { status: 400, body: {
      success: false,
      error: `labeler must be one of: ${validLabelers.join(', ')}`,
    } as ImpulseResolveResponse };
  }

  // A HUMAN verdict needs a human-verdict principal (isHumanVerdictPrincipal above); refused 403
  // otherwise, with nothing written. The refusal names the scope needed, not the caller's key.
  const gvlHuman = gvlPointer.labeler === 'human';
  if (gvlHuman && !isHumanVerdictPrincipal(jwtAuth)) {
    logger.warn('goal_verification_label_write REFUSED: labeler "human" from a credential without the human-verdict scope', {
      key_id: jwtAuth.keyId ?? null,
      auth_type: jwtAuth.authType ?? null,
      obo: jwtAuth.obo ? true : false,
      execution_id: gvlPointer.execution_id,
    });
    return { status: 403, body: {
      success: false,
      error: `labeler "human" requires a credential issued with the "${HUMAN_VERDICT_SCOPE}" scope (or "${ADMIN_SCOPE}"), attributable by key id and not on-behalf-of a peer node`,
    } as ImpulseResolveResponse };
  }
  const gvlPrincipal = gvlHuman ? labeledByPrincipal(jwtAuth) : null;

  // GROUNDING (migration 192). A label recorded only a conclusion — verdict, confidence,
  // labeler — never the evidence behind it, so a self-confirming verdict was
  // indistinguishable from a true one. These fields carry WHAT was checked, against WHICH
  // external authority, what was EXPECTED, and what was OBSERVED.
  //
  // This is also the ONLY grading surface a satisfier reach can use. Measured 2026-08-06:
  // a walk reached via a 2-step chain and wrote a real memoryNote, then logged
  // "reach-patch MATCHED NO ROW ... this execution stays ungraded" — satisfier reaches
  // persist no execution row, so there is nothing for the reach patch to update. The label
  // corpus is keyed by execution_id and does not need that row, so grounding it is what
  // lets a correct reach be recorded at all rather than evaporating.
  //
  // `grounded` is DERIVED HERE and never read from the caller: a field the actor can set is
  // a field the actor can assert itself into. It is the aggregate to trust — "fraction of
  // labels that are grounded" is the honest measure of whether this system can know
  // anything about itself, and it starts at 0%.
  //
  // An authority counts as external only if this substrate does not author it: git (it
  // pushes but cannot forge the remote), the filesystem, process/systemd state, a
  // third-party HTTP status, journald, or a human. journald is the sharpest and cheapest —
  // a log line proves a BRANCH EXECUTED, which is how a drafting floor that had never once
  // run was finally caught while looking healthy the entire time.
  //
  // An UNRECOGNISED source is stored and simply does not count as grounded; it is never
  // rejected. Migration 101 added ASSERT $value IN ['human','automated'] to labeler,
  // goal-host emitted 'deterministic', every write 500'd, and because the caller is
  // fire-and-forget the corpus's most trustworthy tier died silently for two weeks.
  //
  // LIMIT, stated so the field is not read as more than it is: asserted_at is caller-
  // supplied and therefore FORGEABLE until joined against the execution's own start time.
  // `grounded` currently means "carries external evidence", NOT "was pre-registered".
  const EXTERNAL_SOURCES = ['git', 'filesystem', 'process', 'http', 'journal', 'human'];
  const gvlG = gvlPointer as unknown as {
    asserted_at?: string; source?: string; probe?: string;
    expected?: string; observed?: string; evidence?: string;
    purpose?: string; window_id?: string; sample_draw_id?: string;
  };
  // SurrealDB option<T> accepts NONE, NOT NULL — they are distinct values, and a bound JS
  // null arrives as NULL, so a SCHEMAFULL option field rejects the whole CREATE. Measured
  // 2026-08-06, minutes after the grounding fields first landed: EVERY
  // goal_verification_label_write returned HTTP 500 with "Found NULL for field
  // asserted_at, but expected a option<datetime>" — grounded AND ungrounded alike, so the
  // oracle's own labels died too. goal-host's recordDeterministicLabel is fire-and-forget
  // and never sees the 500, so the feed dies SILENTLY: the exact mechanism that killed the
  // 'deterministic' tier for two weeks after migration 101. Migration 192 was deliberately
  // written option<> with no ASSERT to avoid this, and the BINDING reintroduced it one
  // layer up. The CREATE below therefore wraps each optional field in
  // IF ... IS NULL THEN NONE ELSE ... END — the idiom already proven in this repo
  // (execution-traces.ts:2949, :3032, from the COALESCE-is-not-a-SurrealDB-function
  // repair). `grounded` is a plain bool and always supplied, so it needs no guard.
  //
  // Note the comments live HERE, not inside the CREATE: that template literal is the SQL
  // string, so a // comment inside it is sent to the database, and a backtick inside it
  // terminates the literal.
  const gvlNonEmpty = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;
  const gvlGrounded =
    gvlNonEmpty(gvlG.source) &&
    EXTERNAL_SOURCES.includes(String(gvlG.source)) &&
    gvlNonEmpty(gvlG.probe) &&
    gvlNonEmpty(gvlG.expected) &&
    gvlNonEmpty(gvlG.observed);

  // CALIBRATION (migration 216): name purpose / window_id / sample_draw_id in the CREATE only
  // when the caller supplied them. A SCHEMAFULL table rejects a CREATE naming an undefined
  // field EVEN WITH a NONE value (measured, SurrealDB 3.0.5 without 216), so naming them on
  // every write would kill ALL label writes — the fire-and-forget oracle feed included —
  // wherever 216 has not applied. Field names are fixed literals; values stay bound.
  // NOTES: named only when the caller supplied a value. `notes` is option<string>, and a bound
  // JS null arrives as NULL, which an option field REJECTS ("Found NULL for field `notes`"),
  // measured on SurrealDB 2.3.10 through the surrealdb 2.0.8 SDK against node 1's live field
  // set. Binding `notes ?? null` made every label written without notes a 500. A non-null
  // value is still named and typed by the table as before (an empty string is kept).
  const gvlNotesContent = gvlPointer.notes !== undefined && gvlPointer.notes !== null
    ? `notes: $notes,\n              `
    : '';
  const gvlCalibrationKeys = (['purpose', 'window_id', 'sample_draw_id'] as const)
    .filter((k) => gvlNonEmpty(gvlG[k]));
  const gvlCalibrationContent = gvlCalibrationKeys
    .map((k) => `${k}: $${k},\n              `)
    .join('');
  // REFUSE, DON'T DEGRADE. Measured on SurrealDB 2.3.10 (the fleet version) without 216: the
  // SCHEMAFULL table SILENTLY DROPS undefined fields and the CREATE succeeds, leaving a row
  // indistinguishable from an ordinary human label — which goal-host would then apply as a
  // reach override. A label carrying calibration fields is therefore written as ONE statement
  // that checks the stored row and THROWs when a field did not land; a THROW inside the
  // statement rolls the CREATE back (verified on 2.3.10: zero rows after the throw). Plain
  // labels keep the bare CREATE and are unaffected wherever 216 has not applied.
  const gvlGuard = gvlCalibrationKeys.map((k) => `$c[0].${k} != $${k}`).join(' OR ');
  // PRINCIPAL (migration 219): named in the CREATE only on a human label, so the automated and
  // deterministic feeds write exactly the statement they wrote before. The same refuse-don't-degrade
  // rule as the calibration fields: a human label whose principal did not land (219 not applied, the
  // field silently dropped on 2.3.10) would be indistinguishable from a pre-fix row, so it THROWs
  // and the CREATE rolls back.
  const gvlPrincipalContent = gvlPrincipal ? `labeled_by_principal: $labeled_by_principal,\n        ` : '';
  const gvlChecks: string[] = [];
  if (gvlCalibrationKeys.length > 0) {
    gvlChecks.push(`IF ${gvlGuard} { THROW "calibration fields were not stored on goal_verification_labels (migration 216 not applied)" };`);
  }
  if (gvlPrincipal) {
    gvlChecks.push(`IF $c[0].labeled_by_principal.key_id != $principal_key_id { THROW "labeled_by_principal was not stored on goal_verification_labels (migration 219 not applied)" };`);
  }
  const gvlWrap = (createSql: string): string => gvlChecks.length === 0
    ? createSql
    : `{ LET $c = (${createSql}); ${gvlChecks.join(' ')} RETURN $c; }`;
  try {
    const created = await executeAsAuth<any>(
      jwtAuth,
      gvlWrap(`CREATE goal_verification_labels CONTENT {
        org_id: $org_id,
        goal: $goal,
        execution_id: $execution_id,
        activity_id: $activity_id,
        verdict: $verdict,
        confidence: $confidence,
        ${gvlNotesContent}labeler: $labeler,
        asserted_at: IF $asserted_at IS NULL THEN NONE ELSE $asserted_at END,
        source: IF $source IS NULL THEN NONE ELSE $source END,
        probe: IF $probe IS NULL THEN NONE ELSE $probe END,
        expected: IF $expected IS NULL THEN NONE ELSE $expected END,
        observed: IF $observed IS NULL THEN NONE ELSE $observed END,
        evidence: IF $evidence IS NULL THEN NONE ELSE $evidence END,
        ${gvlCalibrationContent}${gvlPrincipalContent}grounded: $grounded,
        created_at: time::now()
      }`),
      {
        org_id: jwtAuth.orgId,
        goal: gvlPointer.goal,
        execution_id: gvlPointer.execution_id,
        activity_id: gvlPointer.activity_id,
        verdict: gvlPointer.verdict,
        confidence: gvlPointer.confidence,
        notes: gvlPointer.notes ?? null,
        labeler: gvlPointer.labeler,
        asserted_at: gvlNonEmpty(gvlG.asserted_at) ? gvlG.asserted_at : null,
        source: gvlNonEmpty(gvlG.source) ? gvlG.source : null,
        probe: gvlNonEmpty(gvlG.probe) ? String(gvlG.probe).slice(0, 2000) : null,
        expected: gvlNonEmpty(gvlG.expected) ? String(gvlG.expected).slice(0, 2000) : null,
        observed: gvlNonEmpty(gvlG.observed) ? String(gvlG.observed).slice(0, 2000) : null,
        // Evidence is raw probe output; cap it so one pathological probe cannot bloat the corpus.
        evidence: gvlNonEmpty(gvlG.evidence) ? String(gvlG.evidence).slice(0, 4000) : null,
        // CALIBRATION (migration 216). purpose 'calibration' marks a blind-calibration-sheet
        // verdict that readers turning labels into overrides, gaps or credit must skip;
        // window_id / sample_draw_id key the surface's calibration report. Stored as given,
        // never validated against a list (an unknown purpose is stored, not rejected).
        purpose: gvlNonEmpty(gvlG.purpose) ? String(gvlG.purpose).slice(0, 64) : null,
        window_id: gvlNonEmpty(gvlG.window_id) ? String(gvlG.window_id).slice(0, 200) : null,
        sample_draw_id: gvlNonEmpty(gvlG.sample_draw_id) ? String(gvlG.sample_draw_id).slice(0, 200) : null,
        grounded: gvlGrounded,
        ...(gvlPrincipal ? { labeled_by_principal: gvlPrincipal, principal_key_id: gvlPrincipal.key_id } : {}),
      },
    );

    const row = (created || [])[0];
    const recordId = row ? String(row.id) : null;

    return { status: 200, body: {
      success: true,
      content: JSON.stringify({ id: recordId }),
      metadata: {
        shape: 'goal_verification_label',
        summary: `goal verification label created: verdict=${gvlPointer.verdict}, labeler=${gvlPointer.labeler}`,
      },
    } as ImpulseResolveResponse };
  } catch (err: any) {
    logger.error('goal_verification_label_write failed', { error: err?.message });
    return { status: 500, body: { success: false, error: err?.message || 'insert failed' } as ImpulseResolveResponse };
  }
}
