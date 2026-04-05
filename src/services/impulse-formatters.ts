/**
 * Impulse Formatters - Format analysis data as markdown for LLM consumption
 *
 * Part of M3: Impulse Bridge - Analysis Integration
 *
 * These formatters convert structured analysis API responses into
 * markdown formatted strings that can be injected into LLM context.
 */

/**
 * Format a single analysis problem/issue as markdown
 */
export function formatAnalysisResultAsMarkdown(problem: {
  id: string;
  component_id: string;
  severity: string;
  category: string;
  message: string;
  impact_score: number;
  status: string;
  resolution_summary?: string;
  created_at?: string;
  updated_at?: string;
}, format: 'full' | 'summary' = 'full'): string {
  if (format === 'summary') {
    return `**[${problem.severity}]** ${problem.category}: ${problem.message} (${problem.component_id})`;
  }

  let md = `# Analysis Result: ${problem.id}\n\n`;
  md += `**Severity**: ${problem.severity}\n`;
  md += `**Category**: ${problem.category}\n`;
  md += `**Component**: \`${problem.component_id}\`\n`;
  md += `**Impact Score**: ${(problem.impact_score * 100).toFixed(0)}%\n`;
  md += `**Status**: ${problem.status}\n\n`;

  md += `## Description\n\n`;
  md += `${problem.message}\n\n`;

  if (problem.resolution_summary) {
    md += `## Resolution\n\n`;
    md += `${problem.resolution_summary}\n\n`;
  }

  // Add component path breakdown for easier navigation
  const parts = problem.component_id.split('::');
  if (parts.length >= 4) {
    md += `## Location\n\n`;
    md += `- **File**: ${parts[0]}\n`;
    md += `- **Type**: ${parts[1]}\n`;
    md += `- **Name**: ${parts[2]}\n`;
    md += `- **Line**: ${parts[3]}\n`;
  }

  return md;
}

/**
 * Format co-change suggestions as markdown
 */
export function formatCochangeAsMarkdown(suggestions: Array<{
  file_path: string;
  confidence: number;
  reason: string;
  affected_components: string[];
  historical_frequency?: number;
  embedding_similarity?: number;
}>): string {
  if (suggestions.length === 0) {
    return `# Co-Change Suggestions\n\nNo co-change suggestions found for the given components.`;
  }

  let md = `# Co-Change Suggestions\n\n`;
  md += `When modifying the specified components, you should also consider:\n\n`;

  md += `| File | Confidence | Reason | Components |\n`;
  md += `|------|------------|--------|------------|\n`;

  for (const s of suggestions) {
    const confidence = `${(s.confidence * 100).toFixed(0)}%`;
    const components = s.affected_components.length > 0
      ? s.affected_components.slice(0, 2).map(c => c.split('::').pop()).join(', ')
      : '-';
    md += `| ${s.file_path} | ${confidence} | ${s.reason} | ${components} |\n`;
  }

  md += `\n## Details\n\n`;

  for (let i = 0; i < Math.min(suggestions.length, 5); i++) {
    const s = suggestions[i]!;
    md += `### ${i + 1}. ${s.file_path}\n\n`;
    md += `- **Confidence**: ${(s.confidence * 100).toFixed(1)}%\n`;
    md += `- **Reason**: ${s.reason}\n`;

    if (s.historical_frequency !== undefined) {
      md += `- **Historical Co-changes**: ${s.historical_frequency}\n`;
    }

    if (s.embedding_similarity !== undefined) {
      md += `- **Semantic Similarity**: ${(s.embedding_similarity * 100).toFixed(1)}%\n`;
    }

    if (s.affected_components.length > 0) {
      md += `- **Affected Components**:\n`;
      for (const comp of s.affected_components.slice(0, 3)) {
        md += `  - \`${comp}\`\n`;
      }
      if (s.affected_components.length > 3) {
        md += `  - ... and ${s.affected_components.length - 3} more\n`;
      }
    }

    md += '\n';
  }

  return md;
}

/**
 * Format impact analysis as markdown
 */
export function formatImpactAsMarkdown(analysis: {
  changed_components: string[];
  direct_dependencies: Array<{
    component_id: string;
    component_name: string;
    file_path: string;
    depth: number;
    risk: string;
    reason: string;
  }>;
  indirect_dependencies: Array<{
    component_id: string;
    component_name: string;
    file_path: string;
    depth: number;
    risk: string;
    reason: string;
  }>;
  affected_tests: Array<{
    component_id: string;
    file_path: string;
  }>;
  risk_level: string;
}): string {
  let md = `# Impact Analysis\n\n`;
  md += `**Risk Level**: ${analysis.risk_level.toUpperCase()}\n\n`;

  md += `## Changed Components\n\n`;
  for (const comp of analysis.changed_components) {
    md += `- \`${comp}\`\n`;
  }

  if (analysis.direct_dependencies.length > 0) {
    md += `\n## Direct Dependencies (Depth 1)\n\n`;
    md += `| Component | File | Risk | Reason |\n`;
    md += `|-----------|------|------|--------|\n`;

    for (const dep of analysis.direct_dependencies) {
      md += `| ${dep.component_name} | ${dep.file_path} | ${dep.risk} | ${dep.reason} |\n`;
    }
  } else {
    md += `\n## Direct Dependencies\n\nNo direct dependencies found.\n`;
  }

  if (analysis.indirect_dependencies.length > 0) {
    md += `\n## Indirect Dependencies (Depth 2+)\n\n`;
    md += `| Component | File | Depth | Risk |\n`;
    md += `|-----------|------|-------|------|\n`;

    for (const dep of analysis.indirect_dependencies.slice(0, 10)) {
      md += `| ${dep.component_name} | ${dep.file_path} | ${dep.depth} | ${dep.risk} |\n`;
    }

    if (analysis.indirect_dependencies.length > 10) {
      md += `\n*... and ${analysis.indirect_dependencies.length - 10} more indirect dependencies*\n`;
    }
  }

  if (analysis.affected_tests.length > 0) {
    md += `\n## Affected Tests\n\n`;
    for (const test of analysis.affected_tests) {
      md += `- ${test.file_path}\n`;
    }
  }

  md += `\n## Summary\n\n`;
  md += `- **Direct dependencies**: ${analysis.direct_dependencies.length}\n`;
  md += `- **Indirect dependencies**: ${analysis.indirect_dependencies.length}\n`;
  md += `- **Tests to update**: ${analysis.affected_tests.length}\n`;

  return md;
}

/**
 * Format codebase search results as markdown
 */
export function formatSearchResultsAsMarkdown(results: Array<{
  id: string;
  component_id: string;
  severity: string;
  category: string;
  message: string;
  impact_score: number;
  similarity_score: number;
  match_reason: string;
}>, query: string): string {
  if (results.length === 0) {
    return `# Search Results: "${query}"\n\nNo results found matching the query.`;
  }

  let md = `# Search Results: "${query}"\n\n`;
  md += `Found ${results.length} result(s)\n\n`;

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    md += `### ${i + 1}. \`${r.component_id}\`\n\n`;
    md += `- **Severity**: ${r.severity}\n`;
    md += `- **Category**: ${r.category}\n`;
    md += `- **Relevance**: ${(r.similarity_score * 100).toFixed(0)}%\n`;
    md += `- **Match Reason**: ${r.match_reason}\n`;
    md += `- **Message**: ${r.message}\n`;
    md += `- **Impact**: ${(r.impact_score * 100).toFixed(0)}%\n`;
    md += '\n';
  }

  return md;
}

// =============================================================================
// UNIFIED LEARNING ARCHITECTURE FORMATTERS
// =============================================================================
// These formatters support the activity-driven learning system where backend
// provides shapes via impulse resolution, and MiniBob drives execution via activities.
// =============================================================================

/**
 * Tool risk level based on error rate
 */
type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

function getRiskLevel(errorRate: number): RiskLevel {
  if (errorRate >= 0.5) return 'critical';
  if (errorRate >= 0.25) return 'high';
  if (errorRate >= 0.1) return 'medium';
  return 'low';
}

function getRiskEmoji(level: RiskLevel): string {
  switch (level) {
    case 'critical': return '🔴';
    case 'high': return '🟠';
    case 'medium': return '🟡';
    case 'low': return '🟢';
  }
}

/**
 * Format tool risk profile as markdown
 * Shows tool error rates, risk indicators, and recommendations
 */
export function formatToolRiskProfileAsMarkdown(toolStats: Array<{
  tool_name: string;
  activity_id?: string;
  call_count: number;
  success_count: number;
  failure_count: number;
  avg_duration_ms: number;
  error_rate?: number;
  typical_errors?: string[];
}>, context?: { activityId?: string; toolName?: string }): string {
  if (toolStats.length === 0) {
    return `# Tool Risk Profile\n\nNo tool usage data available.${context?.activityId ? ` Activity: ${context.activityId}` : ''}`;
  }

  let md = `# Tool Risk Profile\n\n`;

  if (context?.activityId) {
    md += `**Activity**: \`${context.activityId}\`\n\n`;
  }
  if (context?.toolName) {
    md += `**Tool Filter**: \`${context.toolName}\`\n\n`;
  }

  // Summary statistics
  const totalCalls = toolStats.reduce((sum, t) => sum + t.call_count, 0);
  const totalFailures = toolStats.reduce((sum, t) => sum + t.failure_count, 0);
  const overallErrorRate = totalCalls > 0 ? totalFailures / totalCalls : 0;
  const overallRisk = getRiskLevel(overallErrorRate);

  md += `## Summary\n\n`;
  md += `- **Total Tool Calls**: ${totalCalls}\n`;
  md += `- **Total Failures**: ${totalFailures}\n`;
  md += `- **Overall Error Rate**: ${(overallErrorRate * 100).toFixed(1)}% ${getRiskEmoji(overallRisk)}\n`;
  md += `- **Risk Level**: ${overallRisk.toUpperCase()}\n\n`;

  // Tool-by-tool breakdown
  md += `## Tool Breakdown\n\n`;
  md += `| Tool | Calls | Success | Failures | Error Rate | Risk | Avg Time |\n`;
  md += `|------|-------|---------|----------|------------|------|----------|\n`;

  // Sort by error rate (highest first)
  const sorted = [...toolStats].sort((a, b) => {
    const aRate = a.error_rate ?? (a.call_count > 0 ? a.failure_count / a.call_count : 0);
    const bRate = b.error_rate ?? (b.call_count > 0 ? b.failure_count / b.call_count : 0);
    return bRate - aRate;
  });

  for (const tool of sorted) {
    const errorRate = tool.error_rate ?? (tool.call_count > 0 ? tool.failure_count / tool.call_count : 0);
    const risk = getRiskLevel(errorRate);
    const avgTime = tool.avg_duration_ms ? `${tool.avg_duration_ms.toFixed(0)}ms` : '-';

    md += `| ${tool.tool_name} | ${tool.call_count} | ${tool.success_count} | ${tool.failure_count} | ${(errorRate * 100).toFixed(1)}% | ${getRiskEmoji(risk)} ${risk} | ${avgTime} |\n`;
  }

  // High-risk tools section
  const highRiskTools = sorted.filter(t => {
    const rate = t.error_rate ?? (t.call_count > 0 ? t.failure_count / t.call_count : 0);
    return rate >= 0.25 && t.call_count >= 3;
  });

  if (highRiskTools.length > 0) {
    md += `\n## High-Risk Tools (Require Attention)\n\n`;
    for (const tool of highRiskTools) {
      const errorRate = tool.error_rate ?? (tool.call_count > 0 ? tool.failure_count / tool.call_count : 0);
      md += `### ${tool.tool_name}\n\n`;
      md += `- **Error Rate**: ${(errorRate * 100).toFixed(1)}%\n`;
      md += `- **Failure Count**: ${tool.failure_count} / ${tool.call_count} calls\n`;
      if (tool.typical_errors && tool.typical_errors.length > 0) {
        md += `- **Common Errors**:\n`;
        for (const err of tool.typical_errors.slice(0, 3)) {
          md += `  - ${err}\n`;
        }
      }
      md += `\n`;
    }
  }

  // Recommendations
  md += `## Recommendations\n\n`;
  if (overallRisk === 'critical' || overallRisk === 'high') {
    md += `1. **Consider pre-validation**: High error rate suggests validation before execution would help\n`;
    md += `2. **Review argument patterns**: Check tool_argument_pattern table for successful patterns\n`;
    md += `3. **Create debug activity**: Systematically investigate failure causes\n`;
  } else if (overallRisk === 'medium') {
    md += `1. **Monitor trending**: Watch for increasing error rates\n`;
    md += `2. **Document patterns**: Capture successful argument patterns for reuse\n`;
  } else {
    md += `1. **Tools are healthy**: Error rates are acceptable\n`;
    md += `2. **Continue monitoring**: Maintain low error rates\n`;
  }

  return md;
}

/**
 * Format composition success rates as markdown
 * Shows parent→child success patterns by shapes
 */
export function formatCompositionSuccessAsMarkdown(compositions: Array<{
  parent_activity_id: string;
  child_activity_id: string;
  execution_count: number;
  success_count: number;
  weight: number;
  goal_context?: string;
  input_impulse_shapes?: string[];
  output_impulse_shapes?: string[];
  avg_duration_ms?: number;
  avg_cost_usd?: number;
}>, context?: { parentActivityId?: string; childActivityId?: string }): string {
  if (compositions.length === 0) {
    return `# Composition Success Patterns\n\nNo composition data available.`;
  }

  let md = `# Composition Success Patterns\n\n`;

  if (context?.parentActivityId) {
    md += `**Parent Filter**: \`${context.parentActivityId}\`\n`;
  }
  if (context?.childActivityId) {
    md += `**Child Filter**: \`${context.childActivityId}\`\n`;
  }
  md += `\n`;

  // Summary
  const totalExecutions = compositions.reduce((sum, c) => sum + c.execution_count, 0);
  const totalSuccesses = compositions.reduce((sum, c) => sum + c.success_count, 0);
  const overallSuccessRate = totalExecutions > 0 ? totalSuccesses / totalExecutions : 0;

  md += `## Summary\n\n`;
  md += `- **Total Compositions**: ${compositions.length}\n`;
  md += `- **Total Executions**: ${totalExecutions}\n`;
  md += `- **Overall Success Rate**: ${(overallSuccessRate * 100).toFixed(1)}%\n\n`;

  // Composition table
  md += `## Composition Patterns\n\n`;
  md += `| Parent | Child | Executions | Success Rate | Avg Duration | Avg Cost |\n`;
  md += `|--------|-------|------------|--------------|--------------|----------|\n`;

  // Sort by success rate (highest first)
  const sorted = [...compositions].sort((a, b) => b.weight - a.weight);

  for (const comp of sorted) {
    const successRate = `${(comp.weight * 100).toFixed(1)}%`;
    const avgDuration = comp.avg_duration_ms ? `${comp.avg_duration_ms.toFixed(0)}ms` : '-';
    const avgCost = comp.avg_cost_usd ? `$${comp.avg_cost_usd.toFixed(4)}` : '-';

    // Truncate IDs for readability
    const parentShort = comp.parent_activity_id.length > 25
      ? comp.parent_activity_id.substring(0, 22) + '...'
      : comp.parent_activity_id;
    const childShort = comp.child_activity_id.length > 25
      ? comp.child_activity_id.substring(0, 22) + '...'
      : comp.child_activity_id;

    md += `| ${parentShort} | ${childShort} | ${comp.execution_count} | ${successRate} | ${avgDuration} | ${avgCost} |\n`;
  }

  // Shape analysis (if available)
  const withShapes = compositions.filter(c => c.input_impulse_shapes?.length || c.output_impulse_shapes?.length);
  if (withShapes.length > 0) {
    md += `\n## Shape Patterns\n\n`;
    for (const comp of withShapes.slice(0, 5)) {
      md += `### ${comp.parent_activity_id} → ${comp.child_activity_id}\n\n`;
      if (comp.input_impulse_shapes?.length) {
        md += `**Input Shapes**: ${comp.input_impulse_shapes.join(', ')}\n`;
      }
      if (comp.output_impulse_shapes?.length) {
        md += `**Output Shapes**: ${comp.output_impulse_shapes.join(', ')}\n`;
      }
      md += `**Success Rate**: ${(comp.weight * 100).toFixed(1)}%\n\n`;
    }
  }

  // Best compositions
  const bestComps = sorted.filter(c => c.weight >= 0.8 && c.execution_count >= 3).slice(0, 5);
  if (bestComps.length > 0) {
    md += `\n## Proven Compositions (≥80% success, ≥3 executions)\n\n`;
    for (const comp of bestComps) {
      md += `- **${comp.parent_activity_id} → ${comp.child_activity_id}**: ${(comp.weight * 100).toFixed(1)}% (${comp.success_count}/${comp.execution_count})\n`;
    }
  }

  // Risky compositions
  const riskyComps = sorted.filter(c => c.weight < 0.5 && c.execution_count >= 3).slice(0, 5);
  if (riskyComps.length > 0) {
    md += `\n## Risky Compositions (<50% success)\n\n`;
    for (const comp of riskyComps) {
      md += `- **${comp.parent_activity_id} → ${comp.child_activity_id}**: ${(comp.weight * 100).toFixed(1)}% (${comp.success_count}/${comp.execution_count})\n`;
      if (comp.goal_context) {
        md += `  - Context: ${comp.goal_context.substring(0, 100)}...\n`;
      }
    }
  }

  return md;
}

/**
 * Format impulse relevance data as markdown
 * Shows which impulse shapes help activities succeed
 */
export function formatImpulseRelevanceAsMarkdown(relevanceData: Array<{
  impulse_id: string;
  activity_variant_id: string;
  task_id?: string;
  times_loaded: number;
  times_execution_succeeded: number;
  times_execution_failed: number;
  relevance_score: number;
  avg_tokens?: number;
  shape?: string;
}>, context?: { activityId?: string; impulseShape?: string }): string {
  if (relevanceData.length === 0) {
    return `# Impulse Relevance\n\nNo relevance data available.`;
  }

  let md = `# Impulse Relevance Analysis\n\n`;

  if (context?.activityId) {
    md += `**Activity**: \`${context.activityId}\`\n`;
  }
  if (context?.impulseShape) {
    md += `**Shape Filter**: \`${context.impulseShape}\`\n`;
  }
  md += `\n`;

  // Summary
  const avgRelevance = relevanceData.reduce((sum, r) => sum + r.relevance_score, 0) / relevanceData.length;
  const totalLoaded = relevanceData.reduce((sum, r) => sum + r.times_loaded, 0);

  md += `## Summary\n\n`;
  md += `- **Impulse-Activity Pairs**: ${relevanceData.length}\n`;
  md += `- **Total Loads**: ${totalLoaded}\n`;
  md += `- **Average Relevance Score**: ${(avgRelevance * 100).toFixed(1)}%\n\n`;

  // Relevance table
  md += `## Relevance Scores\n\n`;
  md += `| Impulse/Shape | Activity | Loaded | Succeeded | Failed | Relevance | Tokens |\n`;
  md += `|---------------|----------|--------|-----------|--------|-----------|--------|\n`;

  // Sort by relevance score (highest first)
  const sorted = [...relevanceData].sort((a, b) => b.relevance_score - a.relevance_score);

  for (const item of sorted.slice(0, 20)) {
    const impulseDisplay = item.shape || item.impulse_id;
    const impulseShort = impulseDisplay.length > 20
      ? impulseDisplay.substring(0, 17) + '...'
      : impulseDisplay;
    const activityShort = item.activity_variant_id.length > 20
      ? item.activity_variant_id.substring(0, 17) + '...'
      : item.activity_variant_id;
    const tokens = item.avg_tokens ? `~${item.avg_tokens}` : '-';

    md += `| ${impulseShort} | ${activityShort} | ${item.times_loaded} | ${item.times_execution_succeeded} | ${item.times_execution_failed} | ${(item.relevance_score * 100).toFixed(1)}% | ${tokens} |\n`;
  }

  if (sorted.length > 20) {
    md += `\n*... and ${sorted.length - 20} more*\n`;
  }

  // High relevance impulses
  const highRelevance = sorted.filter(r => r.relevance_score >= 0.8 && r.times_loaded >= 3);
  if (highRelevance.length > 0) {
    md += `\n## High-Value Impulses (≥80% relevance)\n\n`;
    md += `These impulses consistently correlate with successful executions:\n\n`;
    for (const item of highRelevance.slice(0, 10)) {
      const display = item.shape || item.impulse_id;
      md += `- **${display}** → \`${item.activity_variant_id}\`: ${(item.relevance_score * 100).toFixed(1)}%\n`;
    }
  }

  // Low relevance impulses (potential noise)
  const lowRelevance = sorted.filter(r => r.relevance_score < 0.3 && r.times_loaded >= 5);
  if (lowRelevance.length > 0) {
    md += `\n## Low-Value Impulses (<30% relevance)\n\n`;
    md += `Consider excluding these impulses to reduce context:\n\n`;
    for (const item of lowRelevance.slice(0, 5)) {
      const display = item.shape || item.impulse_id;
      md += `- **${display}** → \`${item.activity_variant_id}\`: ${(item.relevance_score * 100).toFixed(1)}%\n`;
    }
  }

  return md;
}

/**
 * Format pre-validation result as markdown
 * Shows whether a tool call can be skipped based on historical patterns
 */
export function formatPreValidationResultAsMarkdown(result: {
  canSkip: boolean;
  confidence: number;
  reasoning: string;
  matchingPatterns?: Array<{
    argument_hash: string;
    success_rate: number;
    times_used: number;
    avg_execution_ms?: number;
  }>;
  tool_name: string;
  activity_id: string;
  argument_shape?: string;
}): string {
  let md = `# Pre-Validation Result\n\n`;

  md += `**Tool**: \`${result.tool_name}\`\n`;
  md += `**Activity**: \`${result.activity_id}\`\n`;
  if (result.argument_shape) {
    md += `**Argument Shape**: \`${result.argument_shape}\`\n`;
  }
  md += `\n`;

  // Main decision
  md += `## Decision\n\n`;
  if (result.canSkip) {
    md += `✅ **CAN SKIP**: This tool call can be safely skipped based on historical patterns.\n\n`;
  } else {
    md += `❌ **CANNOT SKIP**: This tool call should be executed.\n\n`;
  }

  md += `**Confidence**: ${(result.confidence * 100).toFixed(1)}%\n`;
  md += `**Reasoning**: ${result.reasoning}\n\n`;

  // Matching patterns
  if (result.matchingPatterns && result.matchingPatterns.length > 0) {
    md += `## Matching Historical Patterns\n\n`;
    md += `| Pattern Hash | Success Rate | Uses | Avg Time |\n`;
    md += `|--------------|--------------|------|----------|\n`;

    for (const pattern of result.matchingPatterns) {
      const hashShort = pattern.argument_hash.substring(0, 12) + '...';
      const avgTime = pattern.avg_execution_ms ? `${pattern.avg_execution_ms.toFixed(0)}ms` : '-';
      md += `| ${hashShort} | ${(pattern.success_rate * 100).toFixed(1)}% | ${pattern.times_used} | ${avgTime} |\n`;
    }
    md += `\n`;
  }

  // Guidance
  md += `## Guidance\n\n`;
  if (result.canSkip) {
    md += `1. **Skip Execution**: The tool call has been validated with similar arguments before\n`;
    md += `2. **Use Cached Result**: Consider using a cached/mocked result if available\n`;
    md += `3. **Record Skip**: Log the skip decision for learning loop feedback\n`;
  } else {
    md += `1. **Execute Tool**: Insufficient historical data or low success rate\n`;
    md += `2. **Record Pattern**: After execution, record argument pattern for future validation\n`;
    md += `3. **Monitor**: Track success/failure for this pattern\n`;
  }

  return md;
}
