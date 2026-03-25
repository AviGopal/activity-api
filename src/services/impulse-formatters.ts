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
