# Comprehensive org_id Type Mismatch Fix Analysis

## Problem Summary

**Root Cause**: SurrealDB 3.0 strict type checking in PERMISSIONS clauses causes failures when comparing:
- Database field `org_id` (can be string or record type)
- JWT claim `$auth.org_id` (format: `"organizations:metabob_internal"` as string)

**Symptom**: Templates endpoint returns 500 error when using API key authentication

**Error Pattern**:
```
"There was a problem with authentication" for query: SELECT * FROM activity_template
```

## Type Casting Solution

Use explicit type casts to handle all combinations:

```surql
-- Pattern for SELECT with OR conditions (global + org filtering)
FOR select WHERE
  (scope = 'global' AND public = true)
  OR (
    org_id = $auth.org_id
    OR org_id = <string>$auth.org_id
    OR <string>org_id = $auth.org_id
    OR <string>org_id = <string>$auth.org_id
  )

-- Pattern for UPDATE/DELETE (direct match only)
FOR update WHERE
  (
    org_id = $auth.org_id
    OR org_id = <string>$auth.org_id
    OR <string>org_id = $auth.org_id
    OR <string>org_id = <string>$auth.org_id
  )
  AND ($auth.role = 'admin' OR created_by = $auth.id)
```

## All Affected Tables

### Core Activity System (HIGH PRIORITY)

1. **activity** (paradigm schema - `020-paradigm-core-tables.surql`)
   - Impact: Template selection, Thompson Sampling, all activity queries
   - Fixed in: migration 074

2. **activity_template** (legacy schema - `001-init-schema.surql`)
   - Impact: Templates endpoint, ribosome, goal processor
   - Status: NEEDS FIX

3. **variant_performance_metrics** (`001-init-schema.surql`)
   - Impact: Thompson Sampling alpha/beta updates
   - Status: NEEDS FIX

4. **activity_execution_traces** (`011-executions.surql`)
   - Impact: Execution filtering, trace retrieval
   - Status: NEEDS FIX

5. **execution** (paradigm schema - `020-paradigm-core-tables.surql`)
   - Impact: New paradigm execution tracking
   - Status: NEEDS FIX

### Composition System (HIGH PRIORITY)

6. **activity_composition_graph** (`012-composition.surql`)
   - Impact: Parent/child activity relationships (NULL bug)
   - Status: NEEDS FIX

7. **composition_edge** (`012-composition.surql`)
   - Impact: Activity dependencies
   - Status: NEEDS FIX

8. **dataflow_connection** (`012-composition.surql`)
   - Impact: Impulse flow tracking
   - Status: NEEDS FIX

9. **prerequisite** (`012-composition.surql`)
   - Impact: Activity ordering
   - Status: NEEDS FIX

10. **composition_instance** (`012-composition.surql`)
    - Impact: Composition execution instances
    - Status: NEEDS FIX

### Goal and Path System (MEDIUM PRIORITY)

11. **goal_execution_paths** (`012-composition.surql`)
    - Impact: Multi-activity path recommendations
    - Status: NEEDS FIX

12. **goal_execution_alignment** (`048-goal-execution-alignment.surql`)
    - Impact: Goal to execution alignment tracking
    - Status: NEEDS FIX

### Impulse System (MEDIUM PRIORITY)

13. **impulse** (paradigm schema - `020-paradigm-core-tables.surql`)
    - Impact: All impulse queries
    - Status: NEEDS FIX

14. **impulse_relevance_metrics** (`013-impulse-tool-usage.surql`)
    - Impact: Impulse relevance scoring
    - Status: NEEDS FIX

15. **impulse_resolution_metrics** (`008-impulse-resolution-metrics.surql`)
    - Impact: Resolver performance tracking
    - Status: NEEDS FIX

16. **impulse_shape_statistics** (`043-impulse-shape-scoring.surql`)
    - Impact: Shape-based scoring
    - Status: NEEDS FIX

### Tool System (MEDIUM PRIORITY)

17. **tool_usage** (`013-impulse-tool-usage.surql`)
    - Impact: Tool invocation patterns
    - Status: NEEDS FIX

18. **tool_argument_pattern** (`029-tool-argument-patterns.surql`)
    - Impact: Tool argument learning
    - Status: NEEDS FIX

19. **tool_execution_stats** (`029-tool-argument-patterns.surql`)
    - Impact: Tool performance stats
    - Status: NEEDS FIX

### Resolver and Pattern System (LOW PRIORITY)

20. **resolver_instance** (`028-resolver-architecture.surql`)
    - Impact: Resolver tracking
    - Status: NEEDS FIX

21. **resolver_trace** (`028-resolver-architecture.surql`)
    - Impact: Resolver execution traces
    - Status: NEEDS FIX

22. **resolver_type_registry** (`028-resolver-architecture.surql`)
    - Impact: Resolver type registration
    - Status: NEEDS FIX

23. **pattern_library** (`018-patterns.surql`)
    - Impact: Reusable patterns
    - Status: NEEDS FIX

24. **llm_resolution_trace** (`017-llm-resolution.surql`)
    - Impact: LLM resolution tracking
    - Status: NEEDS FIX

### Learning and Sequences (LOW PRIORITY)

25. **execution_sequence** (`014-ribosome-sequences.surql`)
    - Impact: Execution sequences
    - Status: NEEDS FIX

26. **state_transition_stats** (`047-progressive-determinism.surql`)
    - Impact: State transition tracking
    - Status: NEEDS FIX

27. **determinism_progression** (`047-progressive-determinism.surql`)
    - Impact: Learning progression
    - Status: NEEDS FIX

### Vessel and Registry (LOW PRIORITY)

28. **vessel** (paradigm and registry schemas)
    - Impact: Vessel registration (if multi-tenant)
    - Status: CHECK IF NEEDS FIX

29. **vessel_circuit_breaker** (`030-circuit-breaker-health.surql`)
    - Impact: Circuit breaker state
    - Status: NEEDS FIX

30. **vessel_health_metrics** (`030-circuit-breaker-health.surql`)
    - Impact: Health monitoring
    - Status: NEEDS FIX

31. **circuit_breaker_trace** (`030-circuit-breaker-health.surql`)
    - Impact: Circuit breaker events
    - Status: NEEDS FIX

32. **routing_trace** (`030-circuit-breaker-health.surql`)
    - Impact: Routing decisions
    - Status: NEEDS FIX

### Views (LOW PRIORITY)

33. **view_activity_template_performance** (`021-paradigm-computed-views.surql`)
    - Impact: Performance views
    - Status: NEEDS FIX

34. **view_execution_cost_analysis** (`021-paradigm-computed-views.surql`)
    - Impact: Cost analysis
    - Status: NEEDS FIX

35. **view_impulse_usage_summary** (`021-paradigm-computed-views.surql`)
    - Impact: Impulse usage stats
    - Status: NEEDS FIX

36. **view_vessel_activity_stats** (`021-paradigm-computed-views.surql`)
    - Impact: Vessel statistics
    - Status: NEEDS FIX

## Migration Strategy

### Phase 1: Critical Path (Migration 074)
Fix tables that directly impact:
- Templates endpoint (activity, activity_template, variant_performance_metrics)
- Composition (activity_composition_graph, composition_edge)
- Execution (activity_execution_traces, execution)

### Phase 2: Core Systems (Migration 075)
Fix remaining core tables:
- Goal execution paths
- Impulse system tables
- Tool usage tables

### Phase 3: Learning System (Migration 076)
Fix learning and tracking tables:
- Resolver traces
- Pattern library
- Execution sequences
- Views

## Testing Requirements

After each migration phase:

1. **Templates Endpoint**: `GET /v2/activities/templates` with API key auth
2. **Composition Graph**: `GET /v2/activities/composition/graph?limit=10`
3. **Execution Storage**: `POST /v2/activities/execution-traces`
4. **Thompson Sampling**: `POST /v2/activities/recommend`
5. **Multi-tenant Isolation**: Verify org_id filtering works correctly

## Rollback Plan

If issues occur:
1. Revert migrations in reverse order
2. Use backup of SurrealDB data
3. Test against previous schema version
