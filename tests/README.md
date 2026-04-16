# Integration Tests

## Phase 5 Validation Tests

Located in `src/services/phase5-integration.test.ts`, these tests validate the deployed Phase 4 infrastructure.

### Test Coverage

**5.2.4: Circuit Breaker**
- Circuit transitions CLOSED → OPEN after 5 failures
- Requests blocked when circuit is OPEN

**5.2.5: Health Scoring**
- Health score decreases after failures
- Vessels below 0.3 threshold excluded from routing

**5.2.6: Routing Traces**
- Routing decisions recorded with metadata
- Traces queryable by shape and outcome

### Running Tests

```bash
# Prerequisites: SurrealDB and Redis running
export SURREALDB_URL="http://surql.metabob.local/rpc"
export SURREALDB_NAMESPACE="activity-system"
export SURREALDB_DATABASE="learning_loop"
export SURREALDB_USERNAME="root"
export SURREALDB_PASSWORD="your-password"
export REDIS_URL="redis://localhost:6379"

# Run Phase 5 tests
bun test src/services/phase5-integration.test.ts

# Run all tests
bun test
```

### Against Canary

```bash
export SURREALDB_URL="https://activity.metabob.com/surql/rpc"
bun test src/services/phase5-integration.test.ts
```
