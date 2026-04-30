# Shape Registry Implementation

**Status:** Implemented (2026-04-10)
**Spec:** `openspec/changes/vessel-integration-standardization/specs/shape-registry/spec.md`

## Overview

The Shape Registry provides versioned shape definitions for impulse validation and vessel-to-vessel communication. It implements semantic versioning with backward compatibility tracking.

## Database Schema

### `shape_definition` Table

Stores versioned shape definitions with JSON schemas and examples.

**Key fields:**
- `name` - Shape name (e.g., "file_diff", "error_log")
- `version` - Semantic version (MAJOR.MINOR.PATCH)
- `schema` - JSON Schema definition
- `description` - Human-readable description
- `example` - Valid example matching schema
- `tags` - Categorization tags
- `public` - If true, visible to all organizations
- `org_id` - Organization ID (null for global shapes)
- `deprecated` - Deprecation flag
- `breaking_changes` - List of breaking changes from previous major
- `changelog` - Version-specific changes

### `routing_trace` Table

Records vessel-to-vessel routing decisions for analytics and optimization.

**Key fields:**
- `shape` - Shape being resolved
- `shape_version` - Requested version constraint
- `selected_vessel_id` - Vessel selected to handle request
- `candidates` - All vessels considered
- `success` - Whether routing succeeded
- `latency_ms` - Routing decision time

### `circuit_breaker_trace` Table

Tracks vessel health and failure patterns for circuit breaker logic.

**Key fields:**
- `vessel_id` - Vessel being monitored
- `state` - Circuit state: closed (healthy), open (failing), half_open (testing)
- `failure_count` - Consecutive failures
- `success_count` - Consecutive successes
- `last_failure_reason` - Most recent failure message

## API Endpoints

### Shape Management

#### `POST /v2/shapes`

Register new shape definition.

**Request:**
```json
{
  "name": "file_diff",
  "version": "1.0.0",
  "schema": { ... },
  "description": "Unified diff format for file changes",
  "example": { ... },
  "tags": ["analysis", "git"],
  "public": true,
  "changelog": "Initial release"
}
```

**Response (201):**
```json
{
  "id": "shape_definition:01HZYX9W3KQZ8YV0GCDPQR5T2F",
  "name": "file_diff",
  "version": "1.0.0",
  "created_at": "2026-04-10T14:30:00Z"
}
```

#### `GET /v2/shapes/:name?version=<constraint>`

Get shape definition by name and optional version constraint.

**Version constraints supported:**
- Exact: `1.2.3`
- Caret: `^1.2.0` (>=1.2.0 <2.0.0)
- Tilde: `~1.2.0` (>=1.2.0 <1.3.0)
- Wildcard: `1.x` (any 1.x.x)

**Response (200):**
```json
{
  "id": "shape_definition:01HZYX9W3KQZ8YV0GCDPQR5T2F",
  "name": "file_diff",
  "version": "1.0.0",
  "schema": { ... },
  "description": "Unified diff format for file changes",
  "example": { ... },
  "tags": ["analysis", "git"],
  "public": true,
  "deprecated": false,
  "created_at": "2026-04-10T14:30:00Z"
}
```

#### `GET /v2/shapes/:name/versions`

List all versions of a shape.

**Response (200):**
```json
{
  "name": "file_diff",
  "versions": [
    {
      "version": "2.0.0",
      "created_at": "2026-04-15T10:00:00Z",
      "breaking_changes": ["Removed old_path field"],
      "deprecated": false
    },
    {
      "version": "1.0.0",
      "created_at": "2026-04-10T14:30:00Z",
      "breaking_changes": [],
      "deprecated": true
    }
  ]
}
```

#### `GET /v2/shapes?tag=<tag>&public_only=<bool>`

List all accessible shapes (latest version only).

**Response (200):**
```json
{
  "shapes": [
    {
      "name": "file_diff",
      "version": "2.0.0",
      "description": "Unified diff format for file changes",
      "tags": ["analysis", "git"],
      "public": true
    }
  ]
}
```

#### `GET /v2/shapes/:name/migrations?from=<version>&to=<version>`

Get migration path between versions.

**Response (200):**
```json
{
  "from": "1.0.0",
  "to": "2.0.0",
  "breaking_changes": [
    "Removed field: old_path",
    "Added field: unified_path (string)"
  ],
  "migration_steps": [
    "Combine old_path and new_path into unified_path",
    "Update all impulse creation code to use unified_path"
  ],
  "changelog": "Major rewrite for improved API"
}
```

### Vessel Discovery (Enhanced)

#### `GET /v2/vessels/discover?shape=<shape>&version=<version>`

Find vessels that can resolve a specific impulse shape, with shape registry integration.

**Response (200):**
```json
{
  "vessels": [
    {
      "id": "vessel_1",
      "name": "discovery-vessel",
      "endpoint": "http://discovery:8080",
      "shapes": ["file_diff", "error_log"],
      "last_heartbeat": "2026-04-10T14:30:00Z"
    }
  ],
  "shape_info": {
    "name": "file_diff",
    "version": "1.0.0",
    "description": "Unified diff format for file changes"
  }
}
```

**Error (404) - Shape not registered:**
```json
{
  "error": "Shape not found in registry",
  "shape": "unknown_shape",
  "suggestion": "Register this shape via POST /v2/shapes before using it"
}
```

#### `GET /v2/vessels/:vesselId/health?check_endpoint=<bool>`

Get comprehensive health score for a vessel.

**Response (200):**
```json
{
  "vesselId": "vessel_1",
  "score": 0.92,
  "status": "healthy",
  "factors": {
    "heartbeat": 0.95,
    "circuitBreaker": 1.0,
    "routingSuccess": 0.8
  },
  "details": {
    "lastHeartbeat": "2026-04-10T14:30:00Z",
    "expiresAt": "2026-04-10T14:35:00Z",
    "circuitState": "closed",
    "recentFailures": 0
  },
  "endpoint_check": {
    "reachable": true,
    "latency_ms": 42
  }
}
```

#### `GET /v2/vessels/health/organization`

Get health scores for all vessels in the organization.

**Response (200):**
```json
{
  "vessels": [ ... ],
  "summary": {
    "total": 5,
    "healthy": 4,
    "degraded": 1,
    "unhealthy": 0,
    "expired": 0,
    "avg_score": 0.87
  }
}
```

## Bootstrap Shapes

The system includes 8 foundational shapes registered on deployment:

1. **memo** (1.0.0) - Embedded text content
2. **file** (1.0.0) - File system reference with path and range
3. **activityExecutionTrace** (1.0.0) - Full execution trace with state
4. **activityTemplate** (1.0.0) - Activity template structure
5. **activityMetrics** (1.0.0) - Performance metrics
6. **error_log** (1.0.0) - Structured error entry
7. **file_diff** (1.0.0) - Unified diff format
8. **code_review_comment** (1.0.0) - Review feedback structure

### Bootstrapping

```bash
# Run after database migration
bun run bootstrap-shapes
```

This creates all 8 shapes as global public shapes (org_id=null, public=true).

## Version Compatibility Rules

### MAJOR Version (Breaking Changes)
- Removed required field
- Changed field type incompatibly (string → number)
- Renamed field without alias
- Changed validation constraints to be more restrictive

### MINOR Version (Backward Compatible Features)
- Added optional field
- Added new enum value
- Relaxed validation constraints
- Added field alias for renamed field

### PATCH Version (Fixes and Documentation)
- Documentation updates
- Example improvements
- Schema description clarifications
- Bug fixes that don't affect validation

## Multi-Tenant Isolation

Shapes support multi-tenant isolation:

- **Global shapes** (org_id=null, public=true): Visible to all organizations
- **Public shapes** (public=true): Visible to all organizations but owned by one
- **Private shapes** (public=false): Only visible to owning organization

Vessel discovery automatically filters by accessible shapes based on org_id.

## Health Scoring

Vessel health scores combine multiple factors:

1. **Heartbeat factor (50% weight)** - Time since last heartbeat
2. **Circuit breaker factor (30% weight)** - Current circuit state and failure count
3. **Routing success factor (20% weight)** - Historical routing success rate

**Health statuses:**
- **healthy**: score >= 0.8
- **degraded**: 0.5 <= score < 0.8
- **unhealthy**: score < 0.5
- **expired**: TTL expired

## Performance

| Operation | Target Latency | Notes |
|-----------|----------------|-------|
| Register shape | <100ms | Includes schema validation |
| Get shape by version | <10ms | Cached in Redis |
| Validate impulse content | <50ms | JSON Schema validation |
| Resolve version constraint | <20ms | In-memory semver resolution |
| List shape versions | <50ms | Database query with index |
| Vessel discovery | <30ms | Shape lookup + vessel query |
| Health score computation | <50ms | Multiple database queries |

## Migration

Migration `056-shape-registry.surql` creates:
- `shape_definition` table with indexes
- `routing_trace` table for routing analytics
- `circuit_breaker_trace` table for health tracking

Run migration:
```bash
bun run init-db
```

Then bootstrap shapes:
```bash
bun run bootstrap-shapes
```

## Testing

Run tests:
```bash
bun test src/routes/shapes.test.ts
```

Test coverage includes:
- Semver parsing and comparison
- Version constraint matching
- Shape registration validation
- Multi-tenant isolation
- Version downgrade prevention
- Migration path queries

## Integration with Impulse Resolution

When creating impulses with shape references:

```typescript
// POST /v2/impulses
{
  "pointer": {
    "type": "memo",
    "content": { ... }
  },
  "metadata": {
    "shape": "file_diff",
    "shape_version": "^1.0.0",  // Version constraint
    "priority": "high",
    "budget": 5000
  }
}
```

The system:
1. Resolves `shape_version` constraint to specific version
2. Validates `pointer.content` against resolved shape schema
3. Stores impulse if valid, rejects with 400 if invalid

## Next Steps

Future enhancements:
1. Shape versioning UI in activity dashboard
2. Automated migration script generation
3. Shape usage analytics and deprecation warnings
4. Cross-vessel shape compatibility matrix
5. Shape evolution visualization
