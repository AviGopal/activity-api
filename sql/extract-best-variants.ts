#!/usr/bin/env bun

/**
 * Extract Best-Performing Template Variants to metabob-proto
 *
 * Periodic script (run weekly/monthly) that:
 * 1. Queries top-performing variants from activity_registry
 * 2. Extracts them to @metabob/proto/activities/bootstrap/
 * 3. Optionally creates a PR with updated templates
 *
 * Selection criteria:
 * - Minimum execution count (statistical significance)
 * - High success rate (alpha / (alpha + beta))
 * - Preference for variants that have evolved from original bootstrap templates
 *
 * Environment variables:
 * - SURREALDB_URL: SurrealDB connection URL
 * - SURREALDB_NAMESPACE: Database namespace
 * - SURREALDB_DATABASE: Database name
 * - SURREALDB_USERNAME: Auth username
 * - SURREALDB_PASSWORD: Auth password
 * - MIN_EXECUTIONS: Minimum executions for statistical significance (default: 10)
 * - MIN_SUCCESS_RATE: Minimum success rate threshold (default: 0.7)
 * - OUTPUT_DIR: Output directory (default: extracted-templates/)
 * - PROTO_PATH: Path to @metabob/proto (optional, for direct update)
 */

import { Surreal } from 'surrealdb';
import { join } from 'path';

const SURREAL_URL = process.env.SURREALDB_URL || 'http://localhost:8000';
const SURREAL_NAMESPACE = process.env.SURREALDB_NAMESPACE || 'metabob';
const SURREAL_DATABASE = process.env.SURREALDB_DATABASE || 'learning_loop';
const SURREAL_USERNAME = process.env.SURREALDB_USERNAME || 'root';
const SURREAL_PASSWORD = process.env.SURREALDB_PASSWORD || 'root';

const MIN_EXECUTIONS = parseInt(process.env.MIN_EXECUTIONS || '10', 10);
const MIN_SUCCESS_RATE = parseFloat(process.env.MIN_SUCCESS_RATE || '0.7');
const OUTPUT_DIR = process.env.OUTPUT_DIR || 'extracted-templates';
const PROTO_PATH = process.env.PROTO_PATH;

interface ActivityRecord {
  id: string;
  name: string;
  description: string;
  category?: string;
  tags: string[];
  task_steps: any[];
  impulses: any[];
  input_schema?: any;
  output_schema?: any;
  executions: number;
  successes: number;
  failures: number;
  alpha: number;
  beta: number;
  avg_duration_ms: number;
  avg_cost_usd: number;
  genealogy?: {
    extracted_from?: string;
    variant_of?: string;
    generation?: number;
  };
  created_at: string;
  updated_at: string;
}

interface ExtractedTemplate {
  name: string;
  description: string;
  category?: string;
  tags: string[];
  task_steps: any[];
  impulses: any[];
  input_schema?: any;
  output_schema?: any;
  variant_id: string;
  activity_id: string;
  version: number;
  contextRequirements: any[];
  // Performance metadata (for reference, not part of execution)
  _extraction_metadata: {
    extracted_at: string;
    source_executions: number;
    source_success_rate: number;
    source_alpha: number;
    source_beta: number;
    avg_duration_ms: number;
    avg_cost_usd: number;
    genealogy?: any;
  };
}

/**
 * Calculate Thompson Sampling expected success rate
 */
function expectedSuccessRate(alpha: number, beta: number): number {
  return alpha / (alpha + beta);
}

/**
 * Convert ActivityRecord to ExtractedTemplate
 */
function toExtractedTemplate(record: ActivityRecord): ExtractedTemplate {
  return {
    name: record.name,
    description: record.description,
    category: record.category,
    tags: record.tags,
    task_steps: record.task_steps,
    impulses: record.impulses,
    input_schema: record.input_schema,
    output_schema: record.output_schema,
    variant_id: record.id,
    activity_id: record.id,
    version: 1,
    contextRequirements: [],
    _extraction_metadata: {
      extracted_at: new Date().toISOString(),
      source_executions: record.executions,
      source_success_rate: expectedSuccessRate(record.alpha, record.beta),
      source_alpha: record.alpha,
      source_beta: record.beta,
      avg_duration_ms: record.avg_duration_ms,
      avg_cost_usd: record.avg_cost_usd,
      genealogy: record.genealogy,
    },
  };
}

async function extractBestVariants() {
  const db = new Surreal();

  try {
    console.log('='.repeat(80));
    console.log('Extract Best-Performing Template Variants');
    console.log('='.repeat(80));
    console.log(`SurrealDB: ${SURREAL_URL}`);
    console.log(`Min Executions: ${MIN_EXECUTIONS}`);
    console.log(`Min Success Rate: ${(MIN_SUCCESS_RATE * 100).toFixed(0)}%`);
    console.log(`Output Directory: ${OUTPUT_DIR}`);
    if (PROTO_PATH) {
      console.log(`Proto Path: ${PROTO_PATH}`);
    }
    console.log('='.repeat(80));

    // Connect
    console.log('\n[Extract] Connecting to SurrealDB...');
    await db.connect(SURREAL_URL);

    await db.signin({
      username: SURREAL_USERNAME,
      password: SURREAL_PASSWORD,
    });

    await db.use({
      namespace: SURREAL_NAMESPACE,
      database: SURREAL_DATABASE,
    });

    // Query best-performing templates
    // Using Thompson Sampling expected value: alpha / (alpha + beta)
    console.log('\n[Extract] Querying best-performing templates...');

    const query = `
      SELECT
        id,
        name,
        description,
        category,
        tags,
        task_steps,
        impulses,
        input_schema,
        output_schema,
        executions,
        successes,
        failures,
        alpha,
        beta,
        avg_duration_ms,
        avg_cost_usd,
        genealogy,
        created_at,
        updated_at,
        (alpha / (alpha + beta)) AS expected_success_rate
      FROM activity_registry
      WHERE execution_format = 'template'
        AND executions >= $min_executions
        AND (alpha / (alpha + beta)) >= $min_success_rate
      ORDER BY expected_success_rate DESC, executions DESC
      LIMIT 50
    `;

    const results = await db.query<any[][]>(query, {
      min_executions: MIN_EXECUTIONS,
      min_success_rate: MIN_SUCCESS_RATE,
    });

    const records = (results[0] || []) as ActivityRecord[];
    console.log(`[Extract] Found ${records.length} qualifying templates`);

    if (records.length === 0) {
      console.log('\n[Extract] No templates meet the criteria.');
      console.log(`[Extract] Criteria: ≥${MIN_EXECUTIONS} executions AND ≥${(MIN_SUCCESS_RATE * 100).toFixed(0)}% success rate`);
      return;
    }

    // Create output directory
    const outputPath = join(process.cwd(), OUTPUT_DIR);
    await Bun.write(join(outputPath, '.gitkeep'), '');
    console.log(`\n[Extract] Writing templates to ${outputPath}...`);

    // Extract each template
    let extractedCount = 0;
    for (const record of records) {
      const template = toExtractedTemplate(record);
      const filename = `${record.id}.json`;
      const filePath = join(outputPath, filename);

      await Bun.write(filePath, JSON.stringify(template, null, 2));

      const successRate = expectedSuccessRate(record.alpha, record.beta);
      console.log(`  ✓ ${filename} (${record.executions} exec, ${(successRate * 100).toFixed(1)}% success)`);
      extractedCount++;
    }

    // If PROTO_PATH is set, also copy to proto directory
    if (PROTO_PATH) {
      const protoBootstrapDir = join(PROTO_PATH, 'activities/bootstrap');
      console.log(`\n[Extract] Updating ${protoBootstrapDir}...`);

      for (const record of records) {
        const template = toExtractedTemplate(record);
        // Remove extraction metadata for proto (it's just for reference)
        const protoTemplate = { ...template };
        delete (protoTemplate as any)._extraction_metadata;

        const filename = `${record.id}.json`;
        const filePath = join(protoBootstrapDir, filename);

        await Bun.write(filePath, JSON.stringify(protoTemplate, null, 2));
        console.log(`  ↑ ${filename}`);
      }

      console.log('\n[Extract] Proto templates updated!');
      console.log('[Extract] Remember to commit changes to metabob-proto repository.');
    }

    // Generate summary report
    const reportPath = join(outputPath, 'EXTRACTION_REPORT.md');
    const report = generateReport(records);
    await Bun.write(reportPath, report);
    console.log(`\n[Extract] Report written to ${reportPath}`);

    // Summary
    console.log('\n' + '='.repeat(80));
    console.log('[Extract] Complete!');
    console.log(`  Extracted: ${extractedCount} templates`);
    console.log(`  Output: ${outputPath}`);
    console.log('='.repeat(80));

  } catch (error) {
    console.error('[Extract] Fatal error:', error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

/**
 * Generate markdown report of extracted templates
 */
function generateReport(records: ActivityRecord[]): string {
  const now = new Date().toISOString();

  let report = `# Template Extraction Report

Generated: ${now}

## Criteria
- Minimum executions: ${MIN_EXECUTIONS}
- Minimum success rate: ${(MIN_SUCCESS_RATE * 100).toFixed(0)}%

## Extracted Templates (${records.length})

| Template | Executions | Success Rate | Avg Duration | Avg Cost |
|----------|------------|--------------|--------------|----------|
`;

  for (const record of records) {
    const successRate = expectedSuccessRate(record.alpha, record.beta);
    report += `| ${record.id} | ${record.executions} | ${(successRate * 100).toFixed(1)}% | ${record.avg_duration_ms.toFixed(0)}ms | $${record.avg_cost_usd.toFixed(4)} |\n`;
  }

  report += `
## Top Performers by Category

`;

  // Group by category
  const byCategory = records.reduce((acc, record) => {
    const cat = record.category || 'uncategorized';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(record);
    return acc;
  }, {} as Record<string, ActivityRecord[]>);

  for (const [category, categoryRecords] of Object.entries(byCategory)) {
    report += `### ${category}\n\n`;
    for (const record of categoryRecords.slice(0, 5)) {
      const successRate = expectedSuccessRate(record.alpha, record.beta);
      report += `- **${record.name}** (${record.id}): ${(successRate * 100).toFixed(1)}% success over ${record.executions} executions\n`;
    }
    report += '\n';
  }

  report += `
## Notes

- Templates with \`_extraction_metadata\` field contain performance data from the source database
- The \`genealogy\` field tracks template evolution (extracted_from, variant_of)
- Thompson Sampling parameters (alpha, beta) represent learned success/failure counts
`;

  return report;
}

// Run extraction
extractBestVariants();
