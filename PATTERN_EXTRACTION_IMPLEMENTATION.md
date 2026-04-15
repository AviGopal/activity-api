# Pattern Extraction Implementation

## Summary

This implementation adds pattern extraction to the backend to learn common input→output shape transformations from execution traces.

## Components Created

### 1. Database Schema (`sql/migrations/062-execution-patterns.surql`)

Created new `execution_pattern` table with fields:
- `input_shapes`: Array of input impulse shapes (sorted)
- `output_shapes`: Array of output impulse shapes (sorted)
- `activity_templates`: Array of activity IDs that executed this pattern
- `success_rate`: Success rate for this pattern
- `execution_count`: Total executions matching this pattern
- `success_count`, `failure_count`: Execution counts
- `avg_cost_usd`, `avg_duration_ms`, `avg_tokens_in`, `avg_tokens_out`: Performance metrics
- `org_id`, `project_id`: Multi-tenancy fields
- `last_executed_at`, `created_at`, `updated_at`: Timestamps

Indexes created for efficient querying by:
- `org_id`
- `input_shapes`, `output_shapes`
- `success_rate`, `execution_count`
- Composite index on `org_id`, `input_shapes`, `output_shapes`

### 2. Pattern Extraction Service (`src/services/pattern-extraction.ts`)

Implements:

**`extractAndUpsertPattern(params)`**
- Extracts input/output shapes from impulses
- Finds existing pattern or creates new one
- Updates rolling averages for metrics (cost, duration, tokens)
- Tracks activity templates that match the pattern

**`queryPatterns(params)`**
- Queries patterns by input shapes, output shapes, or both
- Filters by minimum execution count
- Sorts by success_rate, execution_count, avg_cost_usd, or avg_duration_ms
- Supports pagination

### 3. Patterns Routes (`src/routes/patterns.ts`)

Two endpoints:

**`POST /v2/activities/patterns/query`**
- Request body with flexible query parameters
- Returns patterns with aggregate metrics

**`GET /v2/activities/patterns`**
- Convenience endpoint for GET requests
- Query params: `input_shapes`, `output_shapes`, `min_executions`, `sort_by`, `limit`, `offset`

### 4. Integration Points

#### Execution Trace Storage

Pattern extraction should be called after storing an execution trace in `src/routes/execution-traces.ts`:

```typescript
// After storing execution trace, extract pattern (non-blocking)
import { extractAndUpsertPattern } from '../services/pattern-extraction';

// In POST /v2/activities/execution-traces endpoint:
try {
  const inputImpulses = body.input_impulses || trace.impulses_used || [];
  const rawOutputImpulses = body.output_impulses || body.execution_trace?.impulsesCreated || [];
  const outputImpulses: string[] = rawOutputImpulses.map((imp: any) =>
    typeof imp === 'string' ? imp : (imp?.id || imp?.shape || 'unknown')
  );

  // Fire and forget - don't block the response
  extractAndUpsertPattern({
    executionId: trace.execution_id,
    activityId: trace.variant_id,
    inputImpulses,
    outputImpulses,
    success: trace.success,
    durationMs: trace.duration_ms,
    costUsd: trace.cost_usd,
    tokensIn: trace.tokens_input,
    tokensOut: trace.tokens_output,
    orgId: traceOrgId,
    projectId: traceProjectId,
  }).catch((err) =>
    logger.warn('[pattern-extraction] Pattern extraction failed (non-blocking)', {
      execution_id: trace.execution_id,
      error: err instanceof Error ? err.message : String(err),
    })
  );
} catch (patternError) {
  logger.warn('[pattern-extraction] Failed to initiate pattern extraction', {
    execution_id: trace.execution_id,
    error: patternError instanceof Error ? patternError.message : String(patternError),
  });
}
```

#### Impulse Resolution

Add `executionPattern` case to impulse resolver in `src/routes/impulses.ts`:

```typescript
// Add before default case in switch (pointer.type) statement:
case 'executionPattern': {
  // Resolve patterns by input/output shapes
  const extendedPointer = pointer as typeof pointer & {
    inputShapes?: string[];
    outputShapes?: string[];
    minExecutions?: number;
    sortBy?: 'success_rate' | 'execution_count' | 'avg_cost_usd' | 'avg_duration_ms';
    limit?: number;
  };

  const inputShapes = extendedPointer.inputShapes;
  const outputShapes = extendedPointer.outputShapes;
  const minExecutions = extendedPointer.minExecutions ?? 1;
  const sortBy = extendedPointer.sortBy ?? 'execution_count';
  const limit = Math.min(extendedPointer.limit ?? 10, 100);

  // Get org_id from auth context
  const jwtAuth = getJwtAuthFromContext(c);
  if (!jwtAuth?.orgId) {
    return c.json({
      success: false,
      error: 'Authentication required for executionPattern pointer',
    } as ImpulseResolveResponse, 401);
  }

  // Import pattern extraction service
  const { queryPatterns } = await import('../services/pattern-extraction');

  const result = await queryPatterns({
    orgId: jwtAuth.orgId,
    inputShapes,
    outputShapes,
    minExecutions,
    sortBy,
    limit,
  });

  // Format as markdown
  let markdown = `# Execution Patterns\n\n`;

  if (result.patterns.length === 0) {
    markdown += `No patterns found matching the criteria.\n\n`;
    markdown += `**Filters:**\n`;
    if (inputShapes) markdown += `- Input shapes: ${inputShapes.join(', ')}\n`;
    if (outputShapes) markdown += `- Output shapes: ${outputShapes.join(', ')}\n`;
    markdown += `- Minimum executions: ${minExecutions}\n`;
  } else {
    markdown += `Found ${result.patterns.length} patterns (${result.total} total)\n\n`;

    for (const pattern of result.patterns) {
      markdown += `## Pattern: ${pattern.input_shapes.join(' + ')} → ${pattern.output_shapes.join(' + ')}\n\n`;
      markdown += `**Metrics:**\n`;
      markdown += `- Success rate: ${(pattern.success_rate * 100).toFixed(1)}%\n`;
      markdown += `- Executions: ${pattern.execution_count}\n`;
      markdown += `- Avg cost: $${pattern.avg_cost_usd.toFixed(4)}\n`;
      markdown += `- Avg duration: ${pattern.avg_duration_ms.toFixed(0)}ms\n`;
      markdown += `\n**Activities:**\n`;
      for (const activityId of pattern.activity_templates) {
        markdown += `- \`${activityId}\`\n`;
      }
      markdown += `\n`;
    }
  }

  content = markdown;
  break;
}
```

#### Main App Registration

Add to `src/index.ts`:

```typescript
// Add import
import patternsRoutes from './routes/patterns';

// Add route registration (with other v2 routes)
app.route('/v2/activities/patterns', patternsRoutes);
```

## Testing

### 1. Apply Database Migration

```bash
cd /home/avi/documents/work/exp-repo/metabob-devbob/repos/metabob-activity-api

# Run migration
cat sql/migrations/062-execution-patterns.surql | \
  surreal sql --endpoint http://localhost:8000 \
  --namespace activity-system --database learning_loop \
  --username root --password "$SURREALDB_PASSWORD"
```

### 2. Test Pattern Extraction

Run several activities with MiniBob to generate execution traces. Then verify patterns are extracted:

```bash
# Query patterns via HTTP
curl -X POST http://activity.metabob.local/v2/activities/patterns/query \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "minExecutions": 1,
    "sortBy": "execution_count",
    "limit": 10
  }'
```

### 3. Test Pattern Resolution

Test the `executionPattern` impulse pointer:

```bash
curl -X POST http://activity.metabob.local/v2/impulses/resolve \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "pointer": {
      "type": "executionPattern",
      "minExecutions": 2,
      "sortBy": "success_rate",
      "limit": 5
    }
  }'
```

### 4. Verify Data

Query SurrealDB directly:

```sql
-- Count patterns
SELECT count() FROM execution_pattern GROUP ALL;

-- View top patterns by success rate
SELECT
  input_shapes,
  output_shapes,
  success_rate,
  execution_count
FROM execution_pattern
ORDER BY success_rate DESC
LIMIT 10;

-- View patterns for specific shape
SELECT * FROM execution_pattern
WHERE 'goal' IN input_shapes
  AND 'source_code' IN output_shapes;
```

## Architecture Alignment

This implementation aligns with the impulse/activity/vessel paradigm:

1. **Patterns are learned, not predefined**: The system discovers patterns through execution traces
2. **Resolvers live where data lives**: Pattern data is stored in the backend, so the backend resolves it
3. **Non-blocking learning**: Pattern extraction doesn't block execution trace storage
4. **Multi-tenant isolation**: Patterns are scoped by org_id with RBAC enforcement
5. **Impulse-driven queries**: Patterns can be queried via impulse resolution

## Future Enhancements

1. **Pattern-based activity recommendation**: Use patterns to suggest activities for given input shapes
2. **Pattern evolution tracking**: Track how patterns change over time
3. **Pattern variants**: Group similar patterns and track variants
4. **Cross-org pattern sharing**: Enable public patterns for common transformations
5. **Pattern confidence scoring**: Add confidence metrics based on recency and consistency
