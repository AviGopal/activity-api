/**
 * Context Impulse Shape Definitions
 *
 * Defines the three context acquisition impulse shapes:
 * - error_log: Extracted error information for debugging
 * - requirement: Structured requirements from specs
 * - codebase_structure: Repository structure and metadata
 */

export interface ErrorLogShape {
  shape: 'error_log'
  error_type: string
  occurred_at: string
  summary: string
  stack_trace?: string
  context_files?: string[]
  command?: string
  task_id?: string
  task_description?: string
}

export interface RequirementShape {
  shape: 'requirement'
  requirement_text: string
  priority: 'SHALL' | 'SHOULD' | 'MAY'
  component?: string
  scenarios?: Array<{
    condition: string
    expected_outcome: string
  }>
  referenced_files?: string[]
  source_file?: string
}

export interface CodebaseStructureShape {
  shape: 'codebase_structure'
  total_files: number
  total_lines?: number
  file_types: Record<string, number>
  root_path: string
  entry_points?: string[]
  config_files?: string[]
  test_directories?: string[]
  dependency_graph?: Record<string, string[]>
  recent_commits?: number
  most_changed_files?: string[]
  summary?: string
}

/**
 * Context shape registry
 * Exported for use by impulse resolution and validation
 */
export const CONTEXT_SHAPES = {
  error_log: {
    name: 'error_log',
    description: 'Error information extracted from execution traces or log files',
    required_fields: ['error_type', 'occurred_at', 'summary'],
    optional_fields: ['stack_trace', 'context_files', 'command', 'task_id', 'task_description'],
  },
  requirement: {
    name: 'requirement',
    description: 'Structured requirement from specification documents',
    required_fields: ['requirement_text', 'priority'],
    optional_fields: ['component', 'scenarios', 'referenced_files', 'source_file'],
  },
  codebase_structure: {
    name: 'codebase_structure',
    description: 'Repository structure and metadata for refactoring activities',
    required_fields: ['total_files', 'file_types', 'root_path'],
    optional_fields: [
      'total_lines',
      'entry_points',
      'config_files',
      'test_directories',
      'dependency_graph',
      'recent_commits',
      'most_changed_files',
      'summary',
    ],
  },
} as const

/**
 * Type guard for error_log shape
 */
export function isErrorLogShape(metadata: unknown): metadata is ErrorLogShape {
  if (typeof metadata !== 'object' || metadata === null) return false
  const obj = metadata as Record<string, unknown>

  return (
    obj.shape === 'error_log' &&
    typeof obj.error_type === 'string' &&
    typeof obj.occurred_at === 'string' &&
    typeof obj.summary === 'string'
  )
}

/**
 * Type guard for requirement shape
 */
export function isRequirementShape(metadata: unknown): metadata is RequirementShape {
  if (typeof metadata !== 'object' || metadata === null) return false
  const obj = metadata as Record<string, unknown>

  return (
    obj.shape === 'requirement' &&
    typeof obj.requirement_text === 'string' &&
    (obj.priority === 'SHALL' || obj.priority === 'SHOULD' || obj.priority === 'MAY')
  )
}

/**
 * Type guard for codebase_structure shape
 */
export function isCodebaseStructureShape(metadata: unknown): metadata is CodebaseStructureShape {
  if (typeof metadata !== 'object' || metadata === null) return false
  const obj = metadata as Record<string, unknown>

  return (
    obj.shape === 'codebase_structure' &&
    typeof obj.total_files === 'number' &&
    typeof obj.file_types === 'object' &&
    typeof obj.root_path === 'string'
  )
}
