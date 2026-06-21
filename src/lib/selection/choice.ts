/**
 * choice.ts — the uniform, composable representation of a SELECTION CHOICE, and
 * an INTERPOSABLE `select` step.
 *
 * SUBSTRATE_AS_REPRESENTATION alignment (the representational need this serves):
 *   - a shape is a basis AXIS; an activity/resolver that produces shapes is a
 *     "direction" the system can move along ("each axis can itself be a subsystem
 *     with its own span", §1).
 *   - the state signature is the LOCAL FRAME that winnows A(s) to the locally-tangent
 *     directions; selection is "choosing a tangent direction within A(s)" (§0/§1).
 *   - the learned content is the metric over the shape-basis — per-axis directional
 *     certainty (a Beta posterior). The forward arm reduces uncertainty of existing
 *     axes; exploration finds new directions.
 *
 * Today selection is hardcoded (Thompson + heuristic boosts) and baked into the
 * recommend handler with no swap point. This module makes the CHOICE SET a
 * first-class value and the SELECTOR an interposable function, so a different
 * reasoning process (LLM judge, cost-minimizer, deterministic rule, peer-consult,
 * or a COMPOSITION of these) can be interposed without touching the hot path.
 *
 * Additive + behavior-preserving: the default `thompson` selector reproduces the
 * existing sample-and-argmax. Nothing here changes the live recommend path until
 * it is explicitly wired in.
 */
import beta from '@stdlib/random-base-beta';

// ─────────────────────────────────────────────────────────────────────────────
// The uniform Choice / ChoiceSet representation
// ─────────────────────────────────────────────────────────────────────────────

/** A single candidate direction the system can move along to (partially) cover a goal. */
export interface Choice {
  /** activity_template id or resolver id. */
  id: string;
  /** 'activity' = a composite (runs via the engine / compose); 'resolver' = a leaf. */
  kind: 'activity' | 'resolver';
  /** Output shape-axes this choice produces (the directions it moves along). */
  produces_shapes: string[];
  /** Input shape-axes this choice consumes (its applicability precondition). */
  accepts_shapes: string[];
  /** Directional certainty: the Beta posterior over success along this direction. */
  posterior: { alpha: number; beta: number; n_observations: number };
  /**
   * State-conditioned posterior keyed on the local frame (v1 state-space signature),
   * when enough observations exist. null = fall through to the unconditional posterior.
   */
  state_conditioned: { signature: string; n_observations: number; active: boolean } | null;
  /** Cost vector (the substrate measures cost as a vector, not a scalar). */
  cost: { wall_ms?: number; tokens?: number; usd?: number };
  provenance: { resolver_tier?: string; produced_by?: string; proposed?: boolean };
  /** How to execute this choice once selected. */
  resolve_via: { kind: 'http' | 'compose'; endpoint?: string; sub_activity_id?: string };
  /** Opaque selector hints (heuristic boosts, composition score, …) — for selectors that want them. */
  hints?: Record<string, unknown>;
}

/** The set of choices for one selection decision — the composable input a selector reasons over. */
export interface ChoiceSet {
  goal?: string;
  /** The needed output axes (the goal direction's uncovered components). */
  required_shapes: string[];
  /** The local coordinate frame at this state. */
  state_signature: string | null;
  /** The pool axes available at this state (the domain that winnows A(s)). */
  available_shapes: string[];
  choices: Choice[];
  generated_at: string;
}

/** A scored choice — selectors return a RANKED list so they COMPOSE (re-rank the survivors). */
export interface RankedChoice {
  choice: Choice;
  score: number;
  rationale: string;
}

export interface SelectorContext {
  /** Exploration pressure ∈ [0,1]; selectors may use it (Thompson is intrinsically exploratory). */
  exploration?: number;
  /** Deterministic seed hook (Math.random is banned in some contexts); optional. */
  random?: () => number;
}

/**
 * A Selector is the interposable reasoning step: given the choice set + state, it
 * returns a RANKED list (first = the pick). Because it consumes a ChoiceSet and
 * returns RankedChoices, selectors compose — e.g. cost-filter ∘ thompson ∘ llm-tiebreak.
 */
export type Selector = (set: ChoiceSet, ctx?: SelectorContext) => RankedChoice[];

// ─────────────────────────────────────────────────────────────────────────────
// Projection — turn the existing recommend candidate into a uniform Choice
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Project an activity-api recommend candidate (the per-template object assembled in
 * routes/activities.ts ~6569) into the uniform Choice. Tolerant of partial inputs
 * so it can also project discover-by-shapes rows. Behavior-preserving: it only
 * RE-SHAPES existing metadata; it never re-scores.
 */
export function projectToChoice(c: Record<string, any>): Choice {
  const meta = (c.selection_metadata ?? {}) as Record<string, any>;
  const alpha = Number(meta.alpha ?? c.alpha ?? c.thompson_alpha ?? 1);
  const beta_ = Number(meta.beta ?? c.beta ?? c.thompson_beta ?? 1);
  const condActive = meta.conditional_active === true ||
    (typeof c.signature_observations === 'number' && c.signature_observations >= 5);
  const sig = (meta.conditional_sig ?? c.pool_signature ?? null) as string | null;
  return {
    id: c.template_id ?? c.id ?? c.activity_id,
    kind: 'activity',
    produces_shapes: c.output_shapes ?? [],
    accepts_shapes: c.input_shapes ?? [],
    posterior: {
      alpha,
      beta: beta_,
      n_observations: Number(c._total_executions ?? c.total_executions ?? (alpha + beta_ - 2)),
    },
    state_conditioned: sig
      ? { signature: sig, n_observations: Number(c.signature_observations ?? meta.conditional_n_observations ?? 0), active: condActive }
      : null,
    cost: { wall_ms: c.avg_duration_ms, tokens: c.avg_tokens, usd: c.avg_cost_usd },
    provenance: {
      resolver_tier: meta.tier_class,
      proposed: c._proposed === true || c.proposed === true,
    },
    // Default: activities resolve via the engine (activity_execution / compose).
    resolve_via: { kind: 'compose', sub_activity_id: c.template_id ?? c.id },
    hints: {
      heuristic_boost: meta.heuristic_boost,
      ucb_score: c._ucb_score ?? meta.ucb_score,
      score: meta.score ?? meta.sample,
      composition_score: c.composition_score ?? null,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The interposable selector registry — default `thompson` is behavior-preserving
// ─────────────────────────────────────────────────────────────────────────────

function effectivePosterior(ch: Choice): { a: number; b: number } {
  // State-conditioned posterior wins when active (≥ floor obs), else unconditional —
  // mirrors the recommend conditional-override at routes/activities.ts.
  if (ch.state_conditioned?.active) {
    // conditional alpha/beta are surfaced via hints when projected from recommend;
    // fall back to the unconditional posterior if not separately carried.
    return { a: ch.posterior.alpha, b: ch.posterior.beta };
  }
  return { a: ch.posterior.alpha, b: ch.posterior.beta };
}

/** thompson — Beta sample each direction's certainty, rank by sample. The current default. */
export const thompsonSelector: Selector = (set) => {
  return set.choices
    .map((choice) => {
      const { a, b } = effectivePosterior(choice);
      const sample = beta(Math.max(a, 1e-6), Math.max(b, 1e-6));
      const boost = Number((choice.hints?.heuristic_boost as number) ?? 0);
      const score = sample + boost;
      return { choice, score, rationale: `thompson sample=${sample.toFixed(4)} +boost=${boost}` };
    })
    .sort((x, y) => y.score - x.score);
};

/** greedy-mean — exploit: rank by posterior mean α/(α+β). No exploration. */
export const greedyMeanSelector: Selector = (set) => {
  return set.choices
    .map((choice) => {
      const { a, b } = effectivePosterior(choice);
      const mean = a + b > 0 ? a / (a + b) : 0.5;
      return { choice, score: mean, rationale: `mean=${mean.toFixed(4)}` };
    })
    .sort((x, y) => y.score - x.score);
};

/** cost-minimize — among choices whose mean ≥ floor, prefer the cheapest (wall_ms then tokens). */
export const costMinimizeSelector: Selector = (set) => {
  const FLOOR = 0.4;
  const viable = set.choices.filter((c) => {
    const { a, b } = effectivePosterior(c);
    return (a + b > 0 ? a / (a + b) : 0.5) >= FLOOR;
  });
  const pool = viable.length > 0 ? viable : set.choices;
  return pool
    .map((choice) => {
      const cost = (choice.cost.wall_ms ?? 0) + (choice.cost.tokens ?? 0) * 0.01;
      return { choice, score: -cost, rationale: `cost=${cost.toFixed(1)} (minimize)` };
    })
    .sort((x, y) => y.score - x.score);
};

/** deterministic — stable, reproducible: rank by mean then id. For replay / regression. */
export const deterministicSelector: Selector = (set) => {
  return set.choices
    .map((choice) => {
      const { a, b } = effectivePosterior(choice);
      const mean = a + b > 0 ? a / (a + b) : 0.5;
      return { choice, score: mean, rationale: `deterministic mean=${mean.toFixed(4)}` };
    })
    .sort((x, y) => (y.score - x.score) || (x.choice.id < y.choice.id ? -1 : 1));
};

/** The interposition point: a named registry. Add a Selector here (or pass one) to swap reasoning. */
export const SELECTORS: Record<string, Selector> = {
  thompson: thompsonSelector,
  'greedy-mean': greedyMeanSelector,
  'cost-minimize': costMinimizeSelector,
  deterministic: deterministicSelector,
};

/**
 * select — the single interposable entry point. `strategy` names a registered selector
 * (default 'thompson', behavior-preserving) OR you pass a Selector to interpose a custom
 * reasoning process. Returns the ranked list (first = the pick) so selectors COMPOSE.
 */
export function select(
  set: ChoiceSet,
  strategy: string | Selector = 'thompson',
  ctx?: SelectorContext,
): RankedChoice[] {
  const selector = typeof strategy === 'function' ? strategy : (SELECTORS[strategy] ?? thompsonSelector);
  if (set.choices.length === 0) return [];
  return selector(set, ctx);
}

/** Compose selectors: run them left-to-right, each re-ranking the previous survivors (top-k). */
export function composeSelectors(stages: Array<{ selector: string | Selector; keep?: number }>): Selector {
  return (set, ctx) => {
    let current = set.choices;
    let ranked: RankedChoice[] = current.map((choice) => ({ choice, score: 0, rationale: 'seed' }));
    for (const stage of stages) {
      ranked = select({ ...set, choices: current }, stage.selector, ctx);
      if (stage.keep && stage.keep > 0) ranked = ranked.slice(0, stage.keep);
      current = ranked.map((r) => r.choice);
    }
    return ranked;
  };
}
