# Metabob Activity API

Lightweight TypeScript server for Metabob activity system - replaces Python RPC API v2 endpoints.

## Overview

This is a TypeScript rewrite of the `repos/metabob-rpc-api` activity system with functionality necessary for metabob-cli operation. It provides a clean, performant API for:

- Activity template management
- Session management with Bearer token authentication
- Impulse storage and retrieval
- Execution tracking and metrics
- Thompson Sampling for template selection

## Architecture

```
┌─────────────────┐
│ metabob-cli     │  (MCP Server)
│  (activity_     │
│   manager.py)   │
└────────┬────────┘
         │ HTTP/REST
         ▼
┌─────────────────┐
│ metabob-        │  (This server - TypeScript/Bun)
│ activity-api    │  Deployed at {host}/v2/*
│  /v2/* routes   │
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌────────┐ ┌────────┐
│SurrealDB│ │ Redis  │
│(primary)│ │(cache) │
└────────┘ └────────┘
```

## Technology Stack

- **Runtime**: [Bun](https://bun.sh) - Fast JavaScript runtime
- **Framework**: [Hono](https://hono.dev) - Lightweight web framework
- **Database**: SurrealDB - Multi-model database
- **Cache**: Redis - In-memory cache for sessions and templates
- **Validation**: Zod - TypeScript-first schema validation

## Prerequisites

1. **Bun** >= 1.0.0
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

2. **SurrealDB** running on port 8000
   ```bash
   docker run -p 8000:8000 surrealdb/surrealdb:latest start
   ```

3. **Redis** running on port 6379
   ```bash
   docker run -p 6379:6379 redis:latest
   ```

## Installation

```bash
cd repos/metabob-activity-api
bun install
```

## Configuration

Create a `.env` file (or set environment variables):

```env
# Server
PORT=8080
HOST=0.0.0.0

# SurrealDB
SURREALDB_URL=http://localhost:8000
SURREALDB_NAMESPACE=metabob
SURREALDB_DATABASE=devbob
SURREALDB_USERNAME=root
SURREALDB_PASSWORD=root

# Redis
REDIS_URL=redis://localhost:6379
REDIS_SESSION_TTL=86400     # 24 hours
REDIS_TEMPLATE_TTL=3600     # 1 hour
REDIS_METRICS_TTL=300       # 5 minutes

# Security
REQUIRE_AUTH=false          # Set to true in production

# Logging
LOG_LEVEL=info              # debug, info, warn, error
LOG_FORMAT=text             # text or json

# CORS
CORS_ORIGINS=*              # Comma-separated list
```

## Development

```bash
# Run with auto-reload
bun run dev

# Run in production mode
bun run start

# Build for production
bun run build

# Run tests
bun test
```

## API Endpoints

### Session Management

```http
POST /v2/session
Authorization: X-API-Key <api_key>

Creates a new session and returns Bearer token
```

### Activity Templates

```http
GET /v2/activities/templates?category=feature&limit=50
Authorization: Bearer <token>

List activity templates with Thompson Sampling scores
```

```http
GET /v2/activities/templates/{template_id}
Authorization: Bearer <token>

Get specific template details
```

```http
POST /v2/activities/templates
Authorization: Bearer <token>
Content-Type: application/json

{
  "activity_id": "add-feature-complete",
  "name": "Add Feature Complete",
  "description": "...",
  "category": "feature",
  "task_steps": [...]
}

Create a new activity template
```

### Impulse Management

```http
POST /v2/impulses
Authorization: Bearer <token>
Content-Type: application/json

{
  "impulse_id": "design-decision-123",
  "project_id": "proj_abc",
  "pointer": {...},
  "budget": 2000
}

Store an impulse
```

```http
GET /v2/impulses/{impulse_id}?project_id=proj_abc
Authorization: Bearer <token>

Retrieve impulse content
```

```http
GET /v2/impulses?project_id=proj_abc&limit=50
Authorization: Bearer <token>

List project impulses
```

### Execution Tracking

```http
POST /v2/activities/executions
Authorization: Bearer <token>
Content-Type: application/json

{
  "execution_id": "exec_abc123",
  "activity_id": "act_feature_123",
  "variant_id": "feature-v1",
  "success": true,
  "duration": 5000,
  "total_cost": 0.05,
  "total_tokens": {...}
}

Record activity execution
```

```http
GET /v2/activities/executions?limit=20&offset=0
Authorization: Bearer <token>

Get execution history
```

## Data Flow Verification

This implementation follows traced dataflows from:
- `COMPLETE_DATA_FLOW_SUMMARY.txt`
- `V2_API_DATA_FLOW_COMPLETE.md`
- `tests/validation-harnesses/README-rpc-api-client-dataflow-alignment.md`

### Upstream Dependencies
- metabob-cli sends requests to `/v2/*` endpoints
- Requests include Bearer tokens from `/v2/session`
- Template recommendations use Thompson Sampling

### Downstream Storage
- SurrealDB stores:
  - `activity_variants` - Template definitions
  - `activity_executions` - Execution history
  - `variant_performance_metrics` - Thompson Sampling state
  - `impulse_data` - Impulse content
- Redis caches:
  - `activity:template:{variant_id}` - Template JSON (1hr TTL)
  - `activity:templates:list` - Template set
  - `sessions.{session_id}` - Session data (24hr TTL)

## Docker Deployment

```dockerfile
FROM oven/bun:1 as build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production
COPY src ./src
COPY tsconfig.json ./

FROM oven/bun:1-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./

ENV NODE_ENV=production
EXPOSE 8080
CMD ["bun", "run", "src/index.ts"]
```

Build and run:
```bash
docker build -t metabob-activity-api .
docker run -p 8080:8080 --env-file .env metabob-activity-api
```

## Testing

Integration tests validate traced dataflows:

```bash
# Run validation harness
bun test:integration

# Expected endpoints to pass:
# ✅ POST /v2/session
# ✅ GET /v2/activities/templates
# ✅ GET /v2/activities/templates/{id}
# ✅ POST /v2/activities/templates
# ✅ POST /v2/activities/executions
# ✅ GET /v2/activities/executions
# ✅ POST /v2/impulses
# ✅ GET /v2/impulses/{id}
```

## Performance Targets

- **Latency**: < 50ms for cached templates
- **Throughput**: > 1000 req/s
- **Memory**: < 100MB baseline
- **Cold Start**: < 500ms

## Migration from Python RPC API

This server replaces the following Python files:
- `repos/metabob-rpc-api/server/routes/activity.py`
- `repos/metabob-rpc-api/server/routes/session.py`
- `repos/metabob-rpc-api/server/routes/impulse.py`

### Key Differences

1. **Simpler**: No Celery, no WebSockets (for now)
2. **Faster**: Bun runtime + Hono framework
3. **Smaller**: ~10MB Docker image vs ~500MB Python
4. **Typed**: Full TypeScript with Zod validation

### What's NOT included (intentionally)

- WebSocket streaming (POST /v2/submit websocket)
- Celery task queuing
- Mixpanel tracking
- GitHub auth endpoints
- Code analysis endpoints (Metabob analysis logic)

These are intentionally excluded to keep the server lightweight and focused on activity system operations for metabob-cli.

## Troubleshooting

### Connection Errors

```bash
# Check SurrealDB
curl http://localhost:8000/health

# Check Redis
redis-cli ping
```

### Template Cache Issues

```bash
# Clear Redis cache
redis-cli FLUSHDB

# Restart server to reload from SurrealDB
bun run start
```

### Auth Issues

Set `REQUIRE_AUTH=false` for development/testing.

## Contributing

1. Follow TypeScript best practices
2. Add tests for new endpoints
3. Update this README for new features
4. Validate against traced dataflows

## License

Proprietary - Metabob Inc.
