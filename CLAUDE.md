# metabob-activity-api Development Guidelines

## Overview

This is the **learning backend** for the activity system. It stores execution traces, runs Thompson Sampling for template selection, tracks impulse relevance, and provides pattern recognition.

> **Canonical reference**: `docs/architecture/IMPULSE_ACTIVITY_FOUNDATION.md`

### What This Service Does

- Store execution traces persistently
- Resolve activity-related impulse pointer types (traces, templates, metrics)
- Thompson Sampling for activity template selection
- Pattern recognition and learning
- Impulse relevance tracking
- Tool usage analysis
- **Register with discovery-vessel** to advertise capabilities

### What This Service Does NOT Do

- Execute activities (MiniBob does this)
- Make decisions about what to do (vessels decide)
- Act as a universal resolver for arbitrary queries
- Manage vessel discovery (discovery-vessel does this)

### Architecture Changes (2026-04-11)

**Before**: Activity-API owned vessel registration via `/v2/vessels/*` endpoints

**After**: Activity-API is a **client** of discovery-vessel:
- Registers itself as a vessel on startup
- Sends heartbeats every 60 seconds
- Advertises shapes: `activityExecutionTrace`, `activityTemplate`, `activityMetrics`, etc.
- Legacy `/v2/vessels/*` endpoints deprecated (proxy mode until July 2026)

## Key Files

```
src/
├── index.ts                 # Server entry point (Hono)
├── routes/
│   ├── activities.ts        # Activity template endpoints
│   ├── impulses.ts          # Impulse resolution endpoints
│   └── auth.ts              # Authentication endpoints
├── services/
│   ├── thompson-sampling.ts # Template selection algorithm
│   └── impulse-formatters.ts# Impulse type handlers
├── models/
│   └── schemas.ts           # SurrealDB schemas
└── db/
    └── paradigm.ts          # Database connection
```

## API Endpoints

### Core Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Health check (includes discovery status) |
| `POST /v2/activities/recommend` | Thompson Sampling recommendations |
| `GET /v2/activities/templates` | List activity templates |
| `POST /v2/impulses/resolve` | Resolve impulse pointers (activity-related shapes) |
| `POST /v2/activities/execution-traces` | Store execution trace |
| `POST /v2/activities/composition` | Record activity composition |
| `POST /v2/activities/impulse-relevance` | Track impulse relevance |
| `POST /v2/activities/tool-usage` | Record tool usage patterns |

### Deprecated Endpoints (Proxy Mode)

| Endpoint | Status | Replacement |
|----------|--------|-------------|
| `POST /v2/vessels/register` | ⚠️ Deprecated | Use discovery-vessel directly |
| `POST /v2/vessels/heartbeat` | ⚠️ Deprecated | Use VesselClient package |
| `GET /v2/vessels/status` | ⚠️ Deprecated | Query discovery-vessel |
| `GET /v2/vessels/discover?shape=X` | ⚠️ Deprecated | Use discovery-vessel `/resolve` |

**Deprecation Timeline**:
- **2026-05-01**: Deprecation notices added (current)
- **2026-07-01**: Endpoints removed, return 410 Gone

**Proxy Mode**: Legacy endpoints currently write to both SurrealDB and discovery-vessel for backward compatibility.

## Development

```bash
# Install dependencies
bun install

# Start development server (hot reload)
bun run dev

# Run tests
bun test

# Type checking
bun run typecheck

# Linting (required before CI)
bun run lint
```

## Environment Variables

### Core Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `8080` |
| `HOST` | Bind address | `0.0.0.0` |
| `LOG_LEVEL` | Logging level | `info` |

### Database Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `SURREALDB_URL` | SurrealDB connection URL | (required) |
| `SURREALDB_NAMESPACE` | Database namespace | `activity-system` |
| `SURREALDB_DATABASE` | Database name | `learning_loop` |
| `SURREALDB_USERNAME` | Auth username | (required) |
| `SURREALDB_PASSWORD` | Auth password | (required) |
| `REDIS_URL` | Redis connection string | (optional) |

### Discovery Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `DISCOVERY_ENABLED` | Enable discovery registration | `true` |
| `DISCOVERY_VESSEL_ENDPOINT` | Discovery service URL | `http://discovery-vessel:8080` |
| `VESSEL_ID` | Unique vessel identifier | `activity-api-${HOSTNAME}` |
| `DISCOVERY_HEARTBEAT_INTERVAL_MS` | Heartbeat interval | `60000` (1 min) |
| `DISCOVERY_RETRY_ATTEMPTS` | Max retry attempts | `3` |

### JWT Secret (Single Source of Truth)

The `apikey_token` JWT ACCESS method (defined in `sql/000-auth-schema.surql`) MUST
use the same secret that `src/services/auth.ts` uses to sign tokens. Otherwise
every authenticated query fails with `"The access method cannot be used in the
requested operation"` — see the v1.12.0 canary regression for an example.

**One source. Two consumers. One placeholder.**

- **Source**: the `JWT_SECRET` environment variable, populated from the k8s
  secret `metabob-activity-api.jwt-secret` (see helmfile + chart `secret.yaml`).
- **Runtime consumer**: `src/config.ts` → `resolveJwtSecret()` reads the env var
  directly. In production, missing env var = startup error. In dev, falls back
  to the explicit sentinel `"dev-only-jwt-secret-do-not-use-in-prod"` with a
  loud warning.
- **Schema consumer**: `scripts/init-database.ts` (the `bun run init-db` job)
  reads the same env var and substitutes the `__JWT_SECRET__` placeholder in
  `.surql` files before sending them to SurrealDB. Files keep the placeholder
  as-checked-in — there is **no working hardcoded secret**.

**Do not** add a `JWT_SECRET` default literal in code. **Do not** put a working
secret value in any `.surql` schema file. If you find yourself wanting to align
two literals, you are reintroducing the duplication that caused the bug.

**Adding a new schema with JWT ACCESS?** Use `KEY '__JWT_SECRET__'` in the
`.surql` file. The init-database substitution and the run-time defense check
will handle the rest.

## CI/CD Integration

This vessel is deployed via the deployment repository CI/CD pipeline.

### Before Push

Ensure these pass locally (CI will run them):
```bash
bun test        # Tests must pass
bun run lint    # Linting must pass
```

### Deployment Flow

1. Push changes to main workspace
2. Sync to `repos/deployment/vessels/metabob-activity-api/`
3. Push to `dev` branch triggers canary deployment
4. Canary validated, then promoted to production

### Endpoints Tested by CI

- `GET /health` - Must return 200
- `GET /v2/activities/templates` - Must return 200-399

## Database Schema

SurrealDB schemas are defined in `sql/migrations/`. Key tables:

| Table | Purpose |
|-------|---------|
| `activity_template` | Activity template definitions |
| `activity_execution_traces` | Execution history with state (includes `tasks` flexible array) |
| `activity_metrics` | Thompson Sampling statistics |
| `tool_argument_pattern` | Tool usage patterns |
| `tool_usage` | Tool invocation patterns |
| `impulse_relevance_metrics` | Impulse relevance tracking |

## Testing

```bash
# Run all tests
bun test

# Run specific test file
bun test src/routes/activities.test.ts

# Run with coverage
bun test --coverage
```

## Bun APIs Used

- `Bun.serve()` with Hono for HTTP routing
- Environment variables via `process.env` (Bun auto-loads .env)
- `bun:test` for testing

## Discovery Integration

Activity-API registers itself with discovery-vessel on startup and sends periodic heartbeats.

### Registered Shapes

Activity-API advertises these impulse shapes:
- `activityExecutionTrace` - Full execution trace with state transitions
- `activityTemplate` - Activity template definitions
- `activityMetrics` - Thompson Sampling statistics
- `activityCompositionGraph` - Activity composition relationships
- `impulseRelevanceMetrics` - Impulse relevance scores
- `toolUsagePatterns` - Tool usage patterns
- `executionSequences` - Execution sequence data

### Health Check with Discovery

The `/health` endpoint now includes discovery status:

```json
{
  "service": "metabob-activity-api",
  "version": "1.2.11",
  "status": "healthy",
  "checks": {
    "redis": {
      "status": "healthy",
      "latency_ms": 5
    },
    "surrealdb": {
      "status": "healthy",
      "latency_ms": 10
    },
    "discovery": {
      "status": "healthy",
      "registered": true,
      "lastHeartbeat": "2026-04-12T12:00:00.000Z",
      "expiresAt": "2026-04-12T12:05:00.000Z"
    }
  }
}
```

**Note**: Discovery is non-critical. Health endpoint returns 200 OK even if discovery registration fails (graceful degradation).

### Discovery Client Integration

Activity-API uses a singleton discovery client (`src/services/discovery-client.ts`):

**Key features**:
- Non-blocking registration (doesn't block server startup)
- Exponential backoff retry logic
- Automatic re-registration after 3 consecutive heartbeat failures
- Graceful shutdown with deregistration

**Startup sequence**:
1. Server starts listening on port
2. Discovery client attempts initial registration (async, non-blocking)
3. Heartbeat manager starts (every 60s)
4. If registration fails, heartbeat manager retries

**Shutdown sequence**:
1. SIGTERM/SIGINT received
2. Stop heartbeat manager
3. Deregister from discovery-vessel
4. Exit cleanly

### Legacy Vessel Endpoints (Deprecated)

All `/v2/vessels/*` endpoints are deprecated and operate in **proxy mode**:

**Proxy behavior**:
- Accepts legacy requests
- Writes to SurrealDB (legacy storage)
- Forwards to discovery-vessel (non-blocking)
- Returns deprecation headers

**Migration path**:
- Phase 1 (Current): Dual-write mode, deprecation warnings
- Phase 2 (May 2026): Clients migrate to discovery-vessel
- Phase 3 (July 2026): Legacy endpoints return 410 Gone

### Related Documentation

- [DISCOVERY_INTEGRATION.md](../../DISCOVERY_INTEGRATION.md) - Complete integration guide
- [repos/metabob-activity-api/DISCOVERY_INTEGRATION.md](DISCOVERY_INTEGRATION.md) - Activity-API specific details
- [packages/vessel-discovery-client/README.md](../../packages/vessel-discovery-client/README.md) - Client package docs
- [IMPULSE_ACTIVITY_FOUNDATION.md](../../docs/architecture/IMPULSE_ACTIVITY_FOUNDATION.md) - Foundation principles
- [DEPLOYMENT_WORKFLOW.md](../deployment/DEPLOYMENT_WORKFLOW.md) - Deployment procedures
- [Root CLAUDE.md](../../CLAUDE.md) - Main development guidelines
