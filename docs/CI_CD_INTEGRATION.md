# CI/CD Integration for metabob-activity-api

This document describes the CI/CD webhook integration that connects GitHub Actions (or other CI providers) to the activity learning system.

## Overview

The CI/CD integration enables the activity system to learn from build, test, and deployment outcomes. When an activity execution results in code changes, those changes are committed to a feature branch, triggering CI workflows. The CI results are reported back to the activity API, which updates Thompson Sampling metrics to improve future template selection.

## Architecture

```
Activity Execution → Code Changes → Git Commit → CI Pipeline → Webhook → Activity API
                                                                              ↓
                                                                    Thompson Sampling Update
                                                                              ↓
                                                                    Future template selection
```

### Components

1. **Backend Endpoint**: `/v2/activities/ci-result` (POST)
2. **GitHub Actions Workflow**: `.github/workflows/ci-webhook.yml`
3. **Database Schema**: `sql/005-ci-integration.surql`
4. **Thompson Sampling**: Updates `variant_performance_metrics`

## Backend API

### POST /v2/activities/ci-result

Receives CI/CD results and updates system state.

**Request Schema:**

```typescript
{
  execution_id: string,           // Activity execution ID
  template_id?: string,            // Template that generated the changes
  branch: string,                  // Git branch name
  commit: string,                  // Git commit SHA
  success: boolean,                // Overall CI success/failure
  duration_ms: number,             // Total CI duration
  ci_provider: "github_actions" | "gitlab_ci" | "jenkins" | "circleci" | "other",
  workflow_name?: string,          // CI workflow name
  run_id?: string,                 // CI run identifier
  run_url?: string,                // URL to CI run logs

  stages?: {
    build?: {
      success: boolean,
      duration_ms?: number,
      error?: string
    },
    typecheck?: {
      success: boolean,
      duration_ms?: number,
      error?: string
    },
    test?: {
      success: boolean,
      duration_ms?: number,
      tests_passed?: number,
      tests_failed?: number,
      coverage_percent?: number,
      error?: string
    },
    lint?: {
      success: boolean,
      duration_ms?: number,
      errors?: number,
      warnings?: number,
      error?: string
    }
  },

  artifacts?: [
    {
      name: string,
      type: "docker_image" | "npm_package" | "binary" | "coverage_report" | "test_report" | "other",
      url?: string,
      size_bytes?: number,
      metadata?: object
    }
  ],

  metadata?: object
}
```

**Response Schema:**

```typescript
{
  success: boolean,
  execution_id: string,
  ci_status_updated: boolean,
  metrics_updated: boolean,
  deployment_enqueued?: boolean,
  message?: string
}
```

**Behavior:**

1. Loads execution trace from database
2. Updates trace with CI status
3. Updates Thompson Sampling metrics:
   - CI success: `thompson_alpha += 0.5`
   - CI failure: `thompson_beta += 0.5`
4. Broadcasts CI result via WebSocket
5. On success, enqueues deployment task to boredom queue

### GET /v2/activities/ci-results

List CI results with filtering.

**Query Parameters:**

- `template_id`: Filter by template
- `branch`: Filter by branch name
- `success`: Filter by success/failure (true/false)
- `limit`: Max results (default 50, max 1000)
- `offset`: Pagination offset (default 0)

**Response:**

```typescript
{
  ci_results: [
    {
      execution_id: string,
      template_id?: string,
      status: string,
      duration_ms: number,
      cost_usd: number,
      ci_status: {
        success: boolean,
        branch: string,
        commit: string,
        provider: string,
        completed_at: string
      },
      created_at: string
    }
  ],
  total: number,
  limit: number,
  offset: number
}
```

## GitHub Actions Workflow

### Setup

1. **Create Repository Secrets:**

   ```bash
   # In GitHub repository settings → Secrets and variables → Actions
   ACTIVITY_API_URL=http://api.minibob.local
   ACTIVITY_API_KEY=your-internal-api-key
   ```

2. **Copy Workflow to Repository:**

   ```bash
   cp repos/metabob-activity-api/.github/workflows/ci-webhook.yml .github/workflows/
   ```

### Workflow Features

- **Triggers on feature branches**: `feature/*`, `bugfix/*`, `refactor/*`, `tool/*`, `infrastructure/*`
- **Build stages**: Install, Build, Typecheck, Test, Lint
- **Docker image creation**: On success, builds and saves Docker image as artifact
- **Coverage reports**: Uploads test coverage as artifact
- **Webhook integration**: Sends results to Activity API with detailed stage metrics
- **Execution ID extraction**: Parses execution ID from commit message `[execution:exec-abc123]`

### Commit Message Format

For automatic execution ID association, include in commit message:

```
feat: implement new endpoint [execution:exec-abc123]
```

The workflow extracts `exec-abc123` and associates CI results with that execution.

### Manual Trigger

You can manually trigger the workflow with a specific execution ID:

```bash
gh workflow run ci-webhook.yml -f execution_id=exec-abc123 -f template_id=template-xyz
```

## Database Schema

The `005-ci-integration.surql` migration adds:

### execution_traces.ci_status

```typescript
{
  success: boolean,
  duration_ms: number,
  provider: string,
  workflow_name?: string,
  run_id?: string,
  run_url?: string,
  branch: string,
  commit: string,
  stages: { ... },
  artifacts: [ ... ],
  completed_at: datetime,
  metadata?: object
}
```

### variant_performance_metrics CI fields

```typescript
{
  ci_pass_count: number,
  ci_fail_count: number,
  ci_success_rate: number
}
```

### Indexes

- `ci_status_success_idx`: Filter by CI success
- `ci_status_branch_idx`: Filter by branch
- `ci_status_completed_idx`: Chronological ordering
- `template_ci_success_idx`: Template + CI success composite

## Thompson Sampling Integration

CI results influence template selection probability:

- **CI Success**: Small boost to `thompson_alpha` (success parameter)
- **CI Failure**: Small penalty to `thompson_beta` (failure parameter)

This creates a feedback loop where templates that produce code passing CI are selected more frequently.

### Example Metrics Update

**Before CI result:**
```
thompson_alpha: 5.0
thompson_beta: 2.0
success_rate: 71.4%
```

**After CI success:**
```
thompson_alpha: 5.5 (+0.5)
thompson_beta: 2.0
success_rate: 73.3% (improved)
```

**After CI failure:**
```
thompson_alpha: 5.0
thompson_beta: 2.5 (+0.5)
success_rate: 66.7% (decreased)
```

## Deployment Queue Integration

When CI succeeds, a deployment task is automatically enqueued:

```typescript
{
  id: "deploy-abc123-1234567890",
  type: "deployment",
  priority: "medium",
  activityId: "deploy-to-staging",
  category: "infrastructure",
  goal: "Deploy feature/new-endpoint (abc123) to staging environment",
  context: {
    execution_id: "exec-abc123",
    template_id: "template-xyz",
    branch: "feature/new-endpoint",
    commit: "abc123def456",
    ci_run_url: "https://github.com/org/repo/actions/runs/12345678",
    artifacts: [...]
  },
  estimatedCost: 0.02,
  estimatedDuration: 60000
}
```

MiniBob instances in boredom mode can claim and execute these deployment tasks.

## WebSocket Updates

CI results are broadcast via WebSocket for live dashboard updates:

```typescript
{
  type: "ci_result",
  data: {
    execution_id: "exec-abc123",
    template_id: "template-xyz",
    success: true,
    branch: "feature/new-endpoint",
    commit: "abc123def456",
    duration_ms: 125000,
    ci_provider: "github_actions",
    workflow_name: "CI with Webhook Integration",
    run_url: "https://github.com/org/repo/actions/runs/12345678",
    timestamp: "2026-03-22T10:30:00.000Z"
  }
}
```

## Testing

### Local Testing

1. **Start the API server:**

   ```bash
   cd repos/metabob-activity-api
   bun run dev
   ```

2. **Send a test webhook:**

   ```bash
   curl -X POST http://localhost:8080/v2/activities/ci-result \
     -H "Content-Type: application/json" \
     -H "X-Internal-Api-Key: test-key" \
     -d '{
       "execution_id": "exec-test-123",
       "branch": "feature/test",
       "commit": "abc123",
       "success": true,
       "duration_ms": 120000,
       "ci_provider": "github_actions",
       "workflow_name": "Test Workflow",
       "run_url": "https://github.com/test/repo/actions/runs/123",
       "stages": {
         "build": { "success": true, "duration_ms": 15000 },
         "typecheck": { "success": true, "duration_ms": 8000 },
         "test": { "success": true, "duration_ms": 45000, "tests_passed": 42, "tests_failed": 0 },
         "lint": { "success": true, "duration_ms": 3000, "errors": 0, "warnings": 2 }
       }
     }'
   ```

3. **Verify response:**

   ```json
   {
     "success": true,
     "execution_id": "exec-test-123",
     "ci_status_updated": true,
     "metrics_updated": true,
     "deployment_enqueued": true,
     "message": "CI passed, execution trace updated, deployment enqueued"
   }
   ```

### Integration Testing

1. **Create test execution trace:**

   ```bash
   curl -X POST http://localhost:8080/v2/activities/execution-traces \
     -H "Content-Type: application/json" \
     -H "X-Internal-Api-Key: test-key" \
     -d '{
       "execution_id": "exec-test-123",
       "template_id": "template-test",
       "status": "success",
       "duration_ms": 5000,
       "cost_usd": 0.05,
       "execution_trace": {
         "tasks": [],
         "impulsesCreated": [],
         "filesModified": ["src/test.ts"]
       }
     }'
   ```

2. **Send CI result**

3. **Query CI results:**

   ```bash
   curl http://localhost:8080/v2/activities/ci-results?template_id=template-test
   ```

4. **Verify Thompson Sampling updated:**

   ```bash
   curl http://localhost:8080/v2/activities/templates?variant_id=template-test
   ```

## Monitoring

### Dashboard Queries

**CI Success Rate by Template:**

```sql
SELECT
  template_id,
  count(ci_status.success = true) / count() as ci_success_rate,
  count() as total_ci_runs
FROM execution_traces
WHERE ci_status IS NOT NONE
GROUP BY template_id
ORDER BY ci_success_rate DESC;
```

**Recent CI Failures:**

```sql
SELECT
  execution_id,
  template_id,
  ci_status.branch,
  ci_status.commit,
  ci_status.stages,
  ci_status.completed_at
FROM execution_traces
WHERE ci_status.success = false
ORDER BY ci_status.completed_at DESC
LIMIT 20;
```

**Templates with Failing CI:**

```sql
SELECT
  template_id,
  count() as failure_count,
  math::mean(ci_status.duration_ms) as avg_duration
FROM execution_traces
WHERE ci_status.success = false
GROUP BY template_id
HAVING failure_count > 3
ORDER BY failure_count DESC;
```

## Troubleshooting

### Webhook not received

1. Check GitHub Actions logs for webhook step
2. Verify `ACTIVITY_API_URL` and `ACTIVITY_API_KEY` secrets
3. Check API server logs: `kubectl logs -n activity-system -l app.kubernetes.io/name=metabob-activity-api -f`
4. Verify network connectivity from GitHub to API endpoint

### Execution trace not found

1. Ensure execution trace was stored before CI runs
2. Verify execution ID format in commit message
3. Check execution ID extraction in workflow logs

### Thompson Sampling not updated

1. Verify template_id is provided or can be loaded from execution trace
2. Check that variant_performance_metrics entry exists for template
3. Review API logs for metrics update errors

### Deployment not enqueued

1. Verify CI success is true
2. Check boredom queue API logs
3. Verify deployment activity template exists (`deploy-to-staging`)

## Future Enhancements

- [ ] Support for deployment result webhooks
- [ ] Integration with GitLab CI, Jenkins, CircleCI
- [ ] Automated rollback on deployment failures
- [ ] CI cost tracking and optimization
- [ ] Flaky test detection and quarantine
- [ ] Performance regression detection
- [ ] Automatic variant creation on repeated CI failures
- [ ] CI result trend analysis and alerts
- [ ] Integration with code review systems
- [ ] Build cache optimization based on success patterns

## References

- Backend API: `repos/metabob-activity-api/src/routes/ci.ts`
- Schema definitions: `repos/metabob-activity-api/src/models/schemas.ts`
- Database migration: `repos/metabob-activity-api/sql/005-ci-integration.surql`
- GitHub workflow: `repos/metabob-activity-api/.github/workflows/ci-webhook.yml`
- Thompson Sampling: `PHASE_1_8_COMPLETE.md`
