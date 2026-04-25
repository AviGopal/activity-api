# Phase 1 Backend Infrastructure - API Reference

**Version:** 1.6.0
**Date:** 2026-04-24
**Base URL:** `https://activity.metabob.com`

## Overview

Phase 1 introduces enhanced endpoints for trajectory-based activity orchestration, supporting real-time execution monitoring, backward chaining (prerequisite discovery), and state transition analysis.

## Endpoints

### 1. WebSocket Real-Time Events

**Endpoint:** `wss://activity.metabob.com/ws`

**Protocol:** WebSocket upgrade

**Authentication:**
```javascript
ws.send(JSON.stringify({
  type: 'authenticate',
  token: '<jwt-token-or-api-key>'
}));
```

**Catchup Protocol (after reconnection):**
```javascript
ws.send(JSON.stringify({
  type: 'catchup',
  lastSeenSequence: 42  // Last sequence number client received
}));
```

**Events Received:**
- `task.started`: Task execution begins
- `task.completed`: Task execution completes
- `task.failed`: Task execution failed
- `tool.call`: Tool invocation (with resolver tier and cost)
- `impulse.resolved`: Impulse resolution event

**Event Format:**
```json
{
  "type": "task.started",
  "sequence": 43,
  "timestamp": "2026-04-24T12:00:00.000Z",
  "data": {
    "execution_id": "exec-123",
    "task_id": "task-1",
    "task_index": 0,
    "description": "Run unit tests",
    "started_at": "2026-04-24T12:00:00.000Z"
  }
}
```

---

### 2. Discover Activities by Shapes (Bidirectional)

**Endpoint:** `POST /v2/activities/discover-by-shapes`

**Purpose:** Find activities by their input/output shapes, supporting both forward (prerequisite discovery) and backward (next-step discovery) chaining.

**Request:**
```json
{
  "required_shapes": ["testResults"],
  "mode": "forward",           // "forward" (default) or "backward"
  "current_shapes": ["sourceCode", "gitDiff"],  // Optional: filter by what's available
  "limit": 10                  // Optional: max results (default: 10)
}
```

**Modes:**
- **forward**: Find activities that PRODUCE the required shapes (backward chaining - find prerequisites)
- **backward**: Find activities that CONSUME the required shapes (forward chaining - find next steps)

**Response:**
```json
{
  "activities": [
    {
      "id": "run-tests",
      "name": "Run Unit Tests",
      "description": "Execute test suite",
      "input_shapes": ["sourceCode"],
      "output_shapes": ["testResults", "coverage"],
      "metrics": {
        "total_executions": 45,
        "successful_executions": 40,
        "success_rate": 0.89,
        "thompson_alpha": 41,
        "thompson_beta": 5,
        "confidence": 0.89,
        "avg_duration_ms": 3200,
        "avg_cost_usd": 0.08
      }
    }
  ],
  "total": 1
}
```

**Use Cases:**
1. **Prerequisite Discovery (forward mode):**
   - "I need `testResults`, who can produce it?" → Returns activities with `output_shapes: ["testResults"]`

2. **Next-Step Discovery (backward mode):**
   - "I have `sourceCode`, what can use it?" → Returns activities with `input_shapes: ["sourceCode"]`

---

### 3. Goal-to-Trajectory Recommendation (Enhanced)

**Endpoint:** `POST /v2/goal-paths/recommend`

**Purpose:** Thompson Sampling-based path recommendation with confidence intervals and endpoint state predictions.

**Request:**
```json
{
  "goal_text": "implement unit tests for authentication",
  "goal_category": "feature",     // Optional: "feature", "bugfix", etc.
  "exploration_rate": 0.1,        // 0.0 (exploit) to 1.0 (explore)
  "top_k": 5                      // Number of recommendations
}
```

**Response:**
```json
{
  "goal_hash": "abc123def456",
  "recommended_paths": [
    {
      "path_activities": [
        "read-authentication-code",
        "generate-test-cases",
        "run-tests"
      ],
      "confidence": 0.87,
      "confidence_interval": {
        "lower": 0.75,
        "upper": 0.94,
        "confidence_level": 0.95
      },
      "endpoint_prediction": {
        "expected_shapes": ["sourceCode", "testCases", "testResults"],
        "missing_shapes": ["coverageReport"],
        "goal_completion": 0.75
      },
      "success_rate": 0.85,
      "avg_duration_ms": 12500,
      "avg_cost_usd": 0.15,
      "total_executions": 23,
      "thompson_params": {
        "alpha": 20,
        "beta": 4
      }
    }
  ]
}
```

**New Fields:**
- `confidence_interval`: Wilson score bounds for success rate
  - `lower`: Lower bound of 95% confidence interval
  - `upper`: Upper bound of 95% confidence interval
  - `confidence_level`: 0.95 (95% confidence)

- `endpoint_prediction`: Predicted state after executing this path
  - `expected_shapes`: Shapes that will be available after execution
  - `missing_shapes`: Goal shapes not yet produced (optional)
  - `goal_completion`: 0.0 to 1.0 (% of goal shapes achieved)

- `thompson_params`: Raw Thompson Sampling parameters
  - `alpha`: Success count + 1 (prior)
  - `beta`: Failure count + 1 (prior)

**Goal Shape Inference:**
The system infers expected shapes from goal text:
- "test", "coverage" → `["testResults", "coverageReport"]`
- "commit", "git" → `["gitCommit", "gitDiff"]`
- "deploy", "production" → `["deploymentStatus", "healthCheck"]`
- "bug", "fix" → `["patch", "testResults"]`
- "feature", "implement" → `["sourceCode", "testResults"]`

---

### 4. State Transition Analysis

**Endpoint:** `GET /v2/activities/composition/state-transitions`

**Purpose:** Analyze how shapes flow through activity compositions, showing transformation success rates and costs.

**Query Parameters:**
- `from_shapes`: JSON array of input shapes (e.g., `["sourceCode"]`)
- `to_shapes`: JSON array of output shapes (e.g., `["testResults"]`)
- `activity_id`: Filter by specific activity (optional)
- `limit`: Max results (default: 50)

**Example Request:**
```http
GET /v2/activities/composition/state-transitions?from_shapes=["sourceCode"]&to_shapes=["testResults"]&limit=10
```

**Response:**
```json
{
  "state_transitions": [
    {
      "transition": "read-file->run-tests",
      "from_shapes": ["sourceCode"],
      "to_shapes": ["testResults", "coverage"],
      "activities": ["read-file", "run-tests"],
      "success_rate": 0.92,
      "total_executions": 67,
      "avg_duration_ms": 3200,
      "avg_cost_usd": 0.08
    },
    {
      "transition": "generate-tests->run-tests",
      "from_shapes": ["sourceCode", "testCases"],
      "to_shapes": ["testResults"],
      "activities": ["generate-tests", "run-tests"],
      "success_rate": 0.88,
      "total_executions": 34,
      "avg_duration_ms": 5400,
      "avg_cost_usd": 0.12
    }
  ],
  "total": 2
}
```

**Use Cases:**
1. **Trajectory Editor:** Show which shapes are produced at each step
2. **Backward Chaining:** Find prerequisite activities for missing shapes
3. **Forward Planning:** Predict state evolution through a trajectory
4. **Cost Estimation:** Estimate trajectory cost based on historical transitions

---

## Integration Examples

### Example 1: Build a Trajectory with Backward Chaining

**Goal:** "Run tests and commit results"

**Step 1:** Infer required endpoint shapes
```javascript
const goalShapes = inferShapesFromGoal("run tests and commit results");
// Returns: ["testResults", "gitCommit"]
```

**Step 2:** Find activities that produce missing shapes
```javascript
POST /v2/activities/discover-by-shapes
{
  "required_shapes": ["testResults"],
  "mode": "forward",
  "limit": 5
}
// Returns: [run-tests, run-integration-tests, ...]
```

**Step 3:** Check prerequisites for selected activity
```javascript
// Selected: run-tests (requires sourceCode)
POST /v2/activities/discover-by-shapes
{
  "required_shapes": ["sourceCode"],
  "mode": "forward",
  "limit": 5
}
// Returns: [read-file, checkout-branch, ...]
```

**Step 4:** Build trajectory
```javascript
trajectory = [
  "read-file",      // Produces: sourceCode
  "run-tests",      // Requires: sourceCode, Produces: testResults
  "git-commit"      // Requires: gitDiff (+ sourceCode), Produces: gitCommit
]
```

---

### Example 2: Real-Time Execution Monitoring

```javascript
const ws = new WebSocket('wss://activity.metabob.com/ws');

ws.onopen = () => {
  // Authenticate
  ws.send(JSON.stringify({
    type: 'authenticate',
    token: API_KEY
  }));
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);

  if (message.type === 'authenticated') {
    console.log('Connected and authenticated');
  }

  if (message.type === 'task.started') {
    console.log(`Task started: ${message.data.description}`);
    // Update UI: Show progress bar for this task
  }

  if (message.type === 'tool.call') {
    console.log(`Tool call: ${message.data.tool_name} (tier: ${message.data.resolver_tier})`);
    // Update UI: Show tool call in execution trace
  }

  if (message.type === 'task.completed') {
    console.log(`Task completed: ${message.data.success ? 'SUCCESS' : 'FAILED'}`);
    // Update UI: Mark task as complete
  }

  // Store last seen sequence for catchup
  if (message.sequence) {
    localStorage.setItem('lastSeenSequence', message.sequence);
  }
};

ws.onclose = () => {
  console.log('Disconnected, will retry...');
  setTimeout(() => {
    // Reconnect and request catchup
    const newWs = new WebSocket('wss://activity.metabob.com/ws');
    newWs.onopen = () => {
      newWs.send(JSON.stringify({
        type: 'authenticate',
        token: API_KEY
      }));
      const lastSeq = parseInt(localStorage.getItem('lastSeenSequence') || '0');
      newWs.send(JSON.stringify({
        type: 'catchup',
        lastSeenSequence: lastSeq
      }));
    };
  }, 5000);
};
```

---

### Example 3: Goal Completion Tracking

```javascript
async function trackGoalCompletion(goalText) {
  // Get recommendation with endpoint prediction
  const response = await fetch('https://activity.metabob.com/v2/goal-paths/recommend', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `ApiKey ${API_KEY}`
    },
    body: JSON.stringify({
      goal_text: goalText,
      exploration_rate: 0.1,
      top_k: 1
    })
  });

  const { recommended_paths } = await response.json();
  const topPath = recommended_paths[0];

  console.log(`Goal: ${goalText}`);
  console.log(`Confidence: ${(topPath.confidence * 100).toFixed(1)}%`);
  console.log(`Confidence Interval: [${(topPath.confidence_interval.lower * 100).toFixed(1)}%, ${(topPath.confidence_interval.upper * 100).toFixed(1)}%]`);
  console.log(`Goal Completion: ${(topPath.endpoint_prediction.goal_completion * 100).toFixed(1)}%`);

  if (topPath.endpoint_prediction.missing_shapes.length > 0) {
    console.log(`Missing shapes: ${topPath.endpoint_prediction.missing_shapes.join(', ')}`);
    // Suggest additional activities to fill gaps
  }

  return topPath;
}
```

---

## Error Handling

All endpoints return standard error responses:

**400 Bad Request:**
```json
{
  "error": "Validation failed",
  "message": "mode must be either 'forward' or 'backward'",
  "details": [...]
}
```

**401 Unauthorized:**
```json
{
  "error": "Authentication failed",
  "message": "Invalid or expired token"
}
```

**500 Internal Server Error:**
```json
{
  "error": "Failed to query state transitions",
  "message": "Database connection error"
}
```

---

## Testing

**Validation Script:**
```bash
cd repos/metabob-activity-api
./scripts/test-phase1-endpoints.sh
```

**WebSocket Reconnection Tests:**
```bash
cd repos/metabob-activity-api
bun test src/websocket/reconnection.test.ts
```

---

## Deployment

**Canary Deployment:**
- Push to `dev` branch → Auto-deploy to `https://activity.metabob.com`
- CI/CD runs type checking and tests
- Health endpoint includes WebSocket status

**Health Check:**
```http
GET /health
```

Response includes:
```json
{
  "status": "healthy",
  "checks": {
    "surrealdb": { "status": "healthy", "latency_ms": 10 },
    "redis": { "status": "healthy", "latency_ms": 5 },
    "discovery": { "status": "healthy", "registered": true }
  }
}
```

---

## Backward Compatibility

✅ All Phase 1 enhancements are backward-compatible:
- Existing `discover-by-shapes` calls work unchanged (defaults to `mode: "forward"`)
- Existing `goal-paths/recommend` calls receive enhanced responses (new fields are optional)
- WebSocket protocol is unchanged (authentication + catchup already implemented)

No client-side changes required for existing integrations.

---

## Next Steps

Phase 2 will implement the frontend components using these backend APIs:
- State space computation (memoized shape tracking)
- Impulse state panel components
- Activity applicability filtering
- Speculative prediction UI
- Thompson Sampling visualization

All required backend infrastructure is now in place and ready for frontend integration.
