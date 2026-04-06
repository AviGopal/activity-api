# metabob-activity-api Development Guidelines

## Overview

This is the **learning backend** for the activity system. It stores execution traces, runs Thompson Sampling for template selection, tracks impulse relevance, and provides pattern recognition.

> **Canonical reference**: `docs/architecture/IMPULSE_ACTIVITY_FOUNDATION.md`

### What This Service Does

- Store execution traces persistently
- Resolve ALL impulse pointer types (not just local)
- Thompson Sampling for activity template selection
- Pattern recognition and learning
- Impulse relevance tracking
- Tool usage analysis

### What This Service Does NOT Do

- Execute activities (MiniBob does this)
- Make decisions about what to do (vessels decide)
- Act as a universal resolver for arbitrary queries

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

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Health check |
| `POST /v2/activities/recommend` | Thompson Sampling recommendations |
| `GET /v2/activities/templates` | List activity templates |
| `POST /v2/impulses/resolve` | Resolve impulse pointers |
| `POST /v2/activities/execution-traces` | Store execution trace |
| `POST /v2/activities/composition` | Record activity composition |
| `POST /v2/activities/impulse-relevance` | Track impulse relevance |
| `POST /v2/activities/tool-usage` | Record tool usage patterns |

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

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `8080` |
| `HOST` | Bind address | `0.0.0.0` |
| `SURREALDB_URL` | SurrealDB connection URL | (required) |
| `SURREALDB_NAMESPACE` | Database namespace | `activity-system` |
| `SURREALDB_DATABASE` | Database name | `learning_loop` |
| `SURREALDB_USERNAME` | Auth username | (required) |
| `SURREALDB_PASSWORD` | Auth password | (required) |
| `REDIS_URL` | Redis connection string | (optional) |
| `LOG_LEVEL` | Logging level | `info` |

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
| `activity_execution_trace` | Execution history with state |
| `activity_execution_task_result` | Per-task results |
| `activity_metrics` | Thompson Sampling statistics |
| `tool_argument_pattern` | Tool usage patterns |

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

## Related Documentation

- [IMPULSE_ACTIVITY_FOUNDATION.md](../../docs/architecture/IMPULSE_ACTIVITY_FOUNDATION.md)
- [DEPLOYMENT_WORKFLOW.md](../deployment/DEPLOYMENT_WORKFLOW.md)
- [Root CLAUDE.md](../../CLAUDE.md)
