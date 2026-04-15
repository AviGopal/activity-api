/**
 * Validation Shape Definitions
 *
 * These shapes are produced by contract enforcement activities.
 * They enable tracking compliance, drift, and contract breaches.
 *
 * Usage in contract activities:
 * - outputSchema.produces: ["validation_report", "compliance_metrics"]
 * - Thompson Sampling learns which contracts detect drift best
 * - Dashboard visualizes compliance across all specs
 */

/**
 * Validation Report
 *
 * Complete report of contract enforcement execution.
 * Includes pass/fail status, evidence, and recommendations.
 */
export interface ValidationReport {
  /** Unique ID for this validation run */
  validationId: string;

  /** Spec being validated against */
  specId: string;
  specVersion: string;

  /** Overall status */
  status: "PASS" | "DRIFT" | "FAIL";

  /** Timestamp of validation */
  validatedAt: string;

  /** Execution time (ms) */
  executionTimeMs: number;

  /** Compliance breakdown */
  compliance: {
    functional: ComplianceSection;
    performance: ComplianceSection;
    validation: ComplianceSection;
  };

  /** Summary statistics */
  summary: {
    totalRequirements: number;
    metRequirements: number;
    failedRequirements: number;
    overallDrift: number; // Percentage: 0.0 = perfect compliance, 1.0 = total drift
  };

  /** Evidence of failures (if any) */
  evidence?: ValidationEvidence[];

  /** Recommendations for fixing failures */
  recommendations?: string[];
}

/**
 * Compliance Section
 *
 * Compliance status for one category (functional, performance, validation)
 */
export interface ComplianceSection {
  /** Number of checks in this category */
  totalChecks: number;

  /** Number of checks that passed */
  passedChecks: number;

  /** Number of checks that failed */
  failedChecks: number;

  /** Drift percentage: (failedChecks / totalChecks) */
  drift: number;

  /** Threshold for this category (from spec) */
  driftThreshold: number;

  /** Whether drift exceeds threshold */
  thresholdViolated: boolean;

  /** Status: PASS | DRIFT | FAIL */
  status: "PASS" | "DRIFT" | "FAIL";
}

/**
 * Validation Evidence
 *
 * Evidence of a specific requirement failure.
 * Links to files, line numbers, command outputs, etc.
 */
export interface ValidationEvidence {
  /** Requirement that failed */
  requirementId: string;
  requirementDescription: string;

  /** Category */
  category: "functional" | "performance" | "validation";

  /** What was expected */
  expected: string;

  /** What was actually found */
  actual: string;

  /** Where the failure occurred */
  location?: {
    file?: string;
    line?: number;
    function?: string;
  };

  /** Command output (if validation used bash/api call) */
  commandOutput?: {
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
  };

  /** Suggested fix */
  suggestedFix?: string;
}

/**
 * Compliance Metrics
 *
 * Quantitative metrics for Thompson Sampling and dashboard visualization.
 * Used to rank contract effectiveness (lower drift = better contract).
 */
export interface ComplianceMetrics {
  /** Spec being measured */
  specId: string;
  specVersion: string;

  /** Enforcement activity that ran */
  activityId: string;
  activityVersion: number;

  /** Timestamp */
  measuredAt: string;

  /** Drift percentages (0.0-1.0) */
  drift: {
    functional: number;
    performance: number;
    validation: number;
    overall: number;
  };

  /** Threshold violations */
  thresholds: {
    functional: { value: number; violated: boolean };
    performance: { value: number; violated: boolean };
    validation: { value: number; violated: boolean };
  };

  /** Execution metadata */
  execution: {
    durationMs: number;
    cost: number; // USD
    deterministic: boolean; // True if 100% bash/pattern checks
  };

  /** Overall status */
  status: "PASS" | "DRIFT" | "FAIL";
}

/**
 * Contract Breach
 *
 * Specific requirement failure detected during enforcement.
 * Used for adversarial breaking and variant creation.
 */
export interface ContractBreach {
  /** Unique ID for this breach */
  breachId: string;

  /** Spec and contract */
  specId: string;
  specVersion: string;
  contractActivityId: string;

  /** Requirement that was breached */
  requirement: {
    id: string;
    description: string;
    category: "functional" | "performance" | "validation";
  };

  /** How it was detected (or not detected) */
  detection: {
    wasDetected: boolean; // False = contract gap
    detectionMethod?: string; // "bash_pattern" | "api_call" | "llm_reasoning"
    confidence?: number; // 0.0-1.0 (for LLM-based detection)
  };

  /** Context of the breach */
  context: {
    file?: string;
    code?: string; // Relevant code snippet
    mutation?: string; // If this was an adversarial mutation
  };

  /** Impact assessment */
  impact: {
    severity: "low" | "medium" | "high" | "critical";
    risk: string; // Human-readable risk description
  };

  /** Suggested contract improvements */
  improvements?: ContractImprovement[];

  /** Timestamp */
  detectedAt: string;
}

/**
 * Contract Improvement
 *
 * Suggestion for strengthening a contract based on detected gap.
 */
export interface ContractImprovement {
  /** Type of improvement */
  type:
    | "add_pattern_check"
    | "add_command_check"
    | "add_integration_test"
    | "tighten_threshold"
    | "add_boundary_check"
    | "add_type_check";

  /** Detailed description */
  description: string;

  /** Example implementation */
  example?: {
    before?: string; // Current contract task (if applicable)
    after: string; // Improved contract task
  };

  /** Expected impact */
  impact: {
    additionalCoverage: string; // What new failures will be caught
    estimatedCost: number; // Execution cost in USD
    deterministic: boolean; // True if bash/pattern, false if LLM
  };
}

/**
 * Shape Registry Entry
 *
 * Metadata for registering these shapes with the activity system.
 */
export const VALIDATION_SHAPES = {
  validation_report: {
    name: "validation_report",
    description: "Complete contract enforcement validation report",
    version: "1.0",
    schema: "ValidationReport",
    examples: [
      "repos/minibob/examples/validation-report-pass.json",
      "repos/minibob/examples/validation-report-drift.json",
      "repos/minibob/examples/validation-report-fail.json",
    ],
  },
  compliance_metrics: {
    name: "compliance_metrics",
    description:
      "Quantitative metrics for Thompson Sampling and dashboards",
    version: "1.0",
    schema: "ComplianceMetrics",
    examples: ["repos/minibob/examples/compliance-metrics.json"],
  },
  contract_breach: {
    name: "contract_breach",
    description:
      "Specific requirement failure (detected or missed by contract)",
    version: "1.0",
    schema: "ContractBreach",
    examples: [
      "repos/minibob/examples/contract-breach-detected.json",
      "repos/minibob/examples/contract-breach-missed.json",
    ],
  },
} as const;

/**
 * Type guard for validation report
 */
export function isValidationReport(obj: unknown): obj is ValidationReport {
  if (typeof obj !== "object" || obj === null) return false;
  const report = obj as Partial<ValidationReport>;
  return (
    typeof report.validationId === "string" &&
    typeof report.specId === "string" &&
    ["PASS", "DRIFT", "FAIL"].includes(report.status || "") &&
    typeof report.compliance === "object"
  );
}

/**
 * Type guard for compliance metrics
 */
export function isComplianceMetrics(obj: unknown): obj is ComplianceMetrics {
  if (typeof obj !== "object" || obj === null) return false;
  const metrics = obj as Partial<ComplianceMetrics>;
  return (
    typeof metrics.specId === "string" &&
    typeof metrics.activityId === "string" &&
    typeof metrics.drift === "object" &&
    typeof metrics.thresholds === "object"
  );
}

/**
 * Type guard for contract breach
 */
export function isContractBreach(obj: unknown): obj is ContractBreach {
  if (typeof obj !== "object" || obj === null) return false;
  const breach = obj as Partial<ContractBreach>;
  return (
    typeof breach.breachId === "string" &&
    typeof breach.specId === "string" &&
    typeof breach.requirement === "object" &&
    typeof breach.detection === "object"
  );
}
