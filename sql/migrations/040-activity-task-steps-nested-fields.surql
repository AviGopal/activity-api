-- =============================================================================
-- Migration: Add nested field definitions for task_steps
-- =============================================================================
-- SurrealDB SCHEMAFULL requires explicit nested field definitions
-- This enables template-based activities with structured task steps
-- =============================================================================

-- Task step array element fields
DEFINE FIELD IF NOT EXISTS task_steps.*.id ON activity_registry TYPE string;
DEFINE FIELD IF NOT EXISTS task_steps.*.description ON activity_registry TYPE string;
DEFINE FIELD IF NOT EXISTS task_steps.*.prompt ON activity_registry TYPE option<object>;
DEFINE FIELD IF NOT EXISTS task_steps.*.prompt.template ON activity_registry TYPE option<string>;
DEFINE FIELD IF NOT EXISTS task_steps.*.prompt.variables ON activity_registry TYPE option<array>;
DEFINE FIELD IF NOT EXISTS task_steps.*.prompt.variables.* ON activity_registry TYPE any;
DEFINE FIELD IF NOT EXISTS task_steps.*.prompt.variables.*.name ON activity_registry TYPE option<string>;
DEFINE FIELD IF NOT EXISTS task_steps.*.prompt.variables.*.type ON activity_registry TYPE option<string>;
DEFINE FIELD IF NOT EXISTS task_steps.*.prompt.variables.*.required ON activity_registry TYPE option<bool>;
DEFINE FIELD IF NOT EXISTS task_steps.*.prompt.variables.*.description ON activity_registry TYPE option<string>;
DEFINE FIELD IF NOT EXISTS task_steps.*.prompt.variables.*.default ON activity_registry TYPE any;
DEFINE FIELD IF NOT EXISTS task_steps.*.prompt.maxTokens ON activity_registry TYPE option<int>;
DEFINE FIELD IF NOT EXISTS task_steps.*.dependencies ON activity_registry TYPE option<array<string>>;
DEFINE FIELD IF NOT EXISTS task_steps.*.validation ON activity_registry TYPE option<object>;
DEFINE FIELD IF NOT EXISTS task_steps.*.validation.requireOutput ON activity_registry TYPE option<bool>;
DEFINE FIELD IF NOT EXISTS task_steps.*.validation.requiredFiles ON activity_registry TYPE option<array<string>>;
DEFINE FIELD IF NOT EXISTS task_steps.*.validation.requiredPatterns ON activity_registry TYPE option<array>;
DEFINE FIELD IF NOT EXISTS task_steps.*.validation.forbiddenPatterns ON activity_registry TYPE option<array>;
DEFINE FIELD IF NOT EXISTS task_steps.*.validation.commands ON activity_registry TYPE option<array>;
DEFINE FIELD IF NOT EXISTS task_steps.*.impulseReferences ON activity_registry TYPE option<array<string>>;
DEFINE FIELD IF NOT EXISTS task_steps.*.retry ON activity_registry TYPE option<object>;
DEFINE FIELD IF NOT EXISTS task_steps.*.retry.maxAttempts ON activity_registry TYPE option<int>;
DEFINE FIELD IF NOT EXISTS task_steps.*.retry.strategy ON activity_registry TYPE option<string>;
DEFINE FIELD IF NOT EXISTS task_steps.*.outputImpulses ON activity_registry TYPE option<array<string>>;

-- Variables array field (top-level)
DEFINE FIELD IF NOT EXISTS variables ON activity_registry TYPE option<array>;
DEFINE FIELD IF NOT EXISTS variables.* ON activity_registry TYPE any;
DEFINE FIELD IF NOT EXISTS variables.*.name ON activity_registry TYPE option<string>;
DEFINE FIELD IF NOT EXISTS variables.*.type ON activity_registry TYPE option<string>;
DEFINE FIELD IF NOT EXISTS variables.*.required ON activity_registry TYPE option<bool>;
DEFINE FIELD IF NOT EXISTS variables.*.description ON activity_registry TYPE option<string>;
DEFINE FIELD IF NOT EXISTS variables.*.default ON activity_registry TYPE any;
