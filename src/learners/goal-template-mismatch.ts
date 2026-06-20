/**
 * F17 goal-template mismatch detector.
 *
 * Subscribes to lifecycle:execution:succeeded events via the in-process
 * broadcaster.subscribe() hook. When a top-level execution completes, compares:
 *   - the goal text (from goalContext.goal)
 *   - the executed template's tags
 * If semantic mismatch is detected, emits a keywordMappingProposal to the bus
 * so future recommendation logic can use the signal to improve tag coverage.
 *
 * This closes the loop between goal dispatch and template quality: templates that
 * consistently execute for mismatched goals surface as candidates for tag update.
 *
 * Design per inv-079 (subagent #47): in-process bus subscriber, ~90 LOC.
 * No persistent storage; proposals are best-effort observability signals.
 */

import { broadcaster } from '../websocket/broadcaster';
import { analyzeTaskSemantics } from '../utils/semantic-tags';
import { logger } from '../utils/logger';
import type { WebSocketMessage } from '../websocket/types';

// Minimum tag-match quality below which we consider the selection a mismatch.
const MISMATCH_THRESHOLD = 0.2;

// Avoid emitting proposals for executions with very short goals (likely tests).
const MIN_GOAL_LENGTH = 10;

interface ExecutionSucceededData {
  executionId?: string;
  templateId?: string;
  templateName?: string;
  outputShapes?: string[];
  parentDepth?: number;
  goalContext?: { goal?: string };
}

interface TemplateRecord {
  id?: string;
  tags?: string[];
  name?: string;
}

/** Fetch template tags from activity-api (in-process SurrealDB, best-effort). */
async function fetchTemplateTags(templateId: string): Promise<string[]> {
  try {
    // Import lazily to avoid circular dep at module load time.
    const { surrealDB } = await import('../db/surreal');
    const rows = await surrealDB.query<TemplateRecord>(
      `SELECT tags FROM activity WHERE meta::id(id) = $tid LIMIT 1`,
      { tid: templateId },
    );
    return (rows[0]?.tags as string[] | undefined) ?? [];
  } catch {
    return [];
  }
}

function goalMatchScore(goalText: string, templateTags: string[]): number {
  if (!goalText || templateTags.length === 0) return 1.0; // assume ok when data absent
  const semantics = analyzeTaskSemantics(goalText);
  return semantics.getMatchQuality(templateTags);
}

function handleExecutionSucceeded(data: ExecutionSucceededData): void {
  // Filter: only top-level executions, only when goal context present.
  if ((data.parentDepth ?? 1) !== 0) return;
  const goal = data.goalContext?.goal;
  if (!goal || goal.length < MIN_GOAL_LENGTH) return;
  const templateId = data.templateId;
  if (!templateId) return;

  // Fire-and-forget async check to keep emit() synchronous.
  void (async () => {
    try {
      const tags = await fetchTemplateTags(templateId);
      const score = goalMatchScore(goal, tags);

      if (score < MISMATCH_THRESHOLD) {
        const goalSemantics = analyzeTaskSemantics(goal);
        const proposal = {
          executionId: data.executionId,
          templateId,
          goalSnippet: goal.slice(0, 120),
          matchScore: Math.round(score * 1000) / 1000,
          goalIntents: goalSemantics.allIntents,
          templateTags: tags.slice(0, 8),
          proposedTagAdditions: goalSemantics.tagPrefixes.filter(
            (p) => !tags.some((t) => t.startsWith(p.split('.')[0]!)),
          ),
        };

        broadcaster.emit({
          type: 'keyword.mapping.proposal' as any,
          timestamp: new Date().toISOString(),
          data: proposal,
        });

        logger.info('[F17] goal-template mismatch detected', {
          executionId: data.executionId,
          templateId,
          matchScore: score,
          goalIntents: goalSemantics.allIntents,
        });
      }
    } catch (err: any) {
      logger.warn('[F17] mismatch check failed', { error: err?.message });
    }
  })();
}

let unsubscribe: (() => void) | null = null;

export function startGoalTemplateMismatchDetector(): void {
  if (unsubscribe) return; // idempotent

  unsubscribe = broadcaster.subscribe((msg: WebSocketMessage) => {
    // Handle both colon-form (legacy) and dot-form (bus-forwarded).
    if (
      msg.type !== 'lifecycle:execution:succeeded' &&
      msg.type !== 'lifecycle.execution.succeeded'
    ) return;

    const d = (msg.data ?? {}) as ExecutionSucceededData;
    handleExecutionSucceeded(d);
  });

  logger.info('[F17] goal-template mismatch detector started');
}

export function stopGoalTemplateMismatchDetector(): void {
  unsubscribe?.();
  unsubscribe = null;
}
