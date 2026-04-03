#!/usr/bin/env bun

/**
 * Seed Bootstrap Templates into Activity Database
 *
 * Deployment-time script that loads bootstrap templates from @metabob/proto
 * and inserts them as GLOBAL PUBLIC templates in the activity_registry.
 *
 * This script:
 * 1. Connects to SurrealDB as root (deployment credentials)
 * 2. Loads all templates from @metabob/proto/activities/bootstrap/
 * 3. Inserts them with scope='global', public=true, boosted alpha
 *
 * Environment variables:
 * - SURREALDB_URL: SurrealDB connection URL
 * - SURREALDB_NAMESPACE: Database namespace
 * - SURREALDB_DATABASE: Database name
 * - SURREALDB_USERNAME: Auth username (root)
 * - SURREALDB_PASSWORD: Auth password
 * - DEFAULT_ORG_ID: Org ID for global templates (default: metabob_internal)
 * - INITIAL_ALPHA: Initial Thompson Sampling alpha (default: 3)
 * - PROTO_PATH: Path to @metabob/proto (default: node_modules/@metabob/proto)
 */

import { Surreal } from 'surrealdb';
import { join } from 'path';
import { readdirSync } from 'fs';

const SURREAL_URL = process.env.SURREALDB_URL || 'http://localhost:8000';
const SURREAL_NAMESPACE = process.env.SURREALDB_NAMESPACE || 'metabob';
const SURREAL_DATABASE = process.env.SURREALDB_DATABASE || 'learning_loop';
const SURREAL_USERNAME = process.env.SURREALDB_USERNAME || 'root';
const SURREAL_PASSWORD = process.env.SURREALDB_PASSWORD || 'root';

const DEFAULT_ORG_ID = process.env.DEFAULT_ORG_ID || 'metabob_internal';
const INITIAL_ALPHA = parseFloat(process.env.INITIAL_ALPHA || '3');
const PROTO_PATH = process.env.PROTO_PATH || join(import.meta.dir, '../node_modules/@metabob/proto');

// Template directories to seed (order matters for logging)
const TEMPLATE_DIRS = [
  { name: 'bootstrap', path: join(PROTO_PATH, 'activities/bootstrap') },
  { name: 'reliability', path: join(PROTO_PATH, 'activities/reliability') },
  { name: 'hypothesis', path: join(PROTO_PATH, 'activities/hypothesis') },
];

interface BootstrapTemplate {
  name: string;
  description: string;
  category?: string;
  tags?: string[];
  tasks?: any[];
  task_steps?: any[];
  variables?: any;
  contextRequirements?: any[];
  impulses?: any[];
  input_schema?: any;
  output_schema?: any;
  variant_id?: string;
  activity_id?: string;
  version?: number;
}

/**
 * Generate tag prefixes for hierarchical queries
 * ["feature.vessel.state"] -> ["feature", "feature.vessel", "feature.vessel.state"]
 */
function generateTagPrefixes(tags: string[]): string[] {
  const prefixes = new Set<string>();
  for (const tag of tags) {
    const parts = tag.split('.');
    for (let i = 1; i <= parts.length; i++) {
      prefixes.add(parts.slice(0, i).join('.'));
    }
  }
  return Array.from(prefixes);
}

/**
 * Load all templates from @metabob/proto (bootstrap, reliability, hypothesis)
 */
async function loadBootstrapTemplates(): Promise<Array<{ filename: string; template: BootstrapTemplate; source: string }>> {
  const templates: Array<{ filename: string; template: BootstrapTemplate; source: string }> = [];

  for (const { name, path } of TEMPLATE_DIRS) {
    try {
      // Check if directory exists
      const dirExists = await Bun.file(join(path, '.')).exists().catch(() => false);
      if (!dirExists) {
        // Try to read directory - if it fails, skip
        try {
          readdirSync(path);
        } catch {
          console.log(`[Seed] Skipping ${name} directory (not found): ${path}`);
          continue;
        }
      }

      const files = readdirSync(path).filter(f => f.endsWith('.json'));
      console.log(`[Seed] Loading ${files.length} templates from ${name}/`);

      for (const file of files) {
        try {
          const filePath = join(path, file);
          const content = await Bun.file(filePath).text();
          const template = JSON.parse(content) as BootstrapTemplate;
          templates.push({ filename: file, template, source: name });
        } catch (error) {
          console.warn(`[Seed] Skipping ${name}/${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      console.warn(`[Seed] Error reading ${name} directory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return templates;
}

async function seedTemplates() {
  const db = new Surreal();

  try {
    console.log('='.repeat(80));
    console.log('Bootstrap Template Seeding');
    console.log('='.repeat(80));
    console.log(`SurrealDB: ${SURREAL_URL}`);
    console.log(`Namespace: ${SURREAL_NAMESPACE}.${SURREAL_DATABASE}`);
    console.log(`Org ID: ${DEFAULT_ORG_ID}`);
    console.log(`Initial Alpha: ${INITIAL_ALPHA}`);
    console.log(`Proto Path: ${PROTO_PATH}`);
    console.log(`Template Dirs: ${TEMPLATE_DIRS.map(d => d.name).join(', ')}`);
    console.log('='.repeat(80));

    // Connect
    console.log('\n[Seed] Connecting to SurrealDB...');
    await db.connect(SURREAL_URL);

    console.log(`[Seed] Signing in as ${SURREAL_USERNAME}...`);
    await db.signin({
      username: SURREAL_USERNAME,
      password: SURREAL_PASSWORD,
    });

    await db.use({
      namespace: SURREAL_NAMESPACE,
      database: SURREAL_DATABASE,
    });

    // Verify organization exists
    console.log(`\n[Seed] Verifying organization ${DEFAULT_ORG_ID}...`);
    const orgCheck = await db.query<any[][]>(
      `SELECT * FROM organizations WHERE id = type::record('organizations', $org_id)`,
      { org_id: DEFAULT_ORG_ID }
    );

    if (!orgCheck[0] || orgCheck[0].length === 0) {
      console.error(`[Seed] Organization ${DEFAULT_ORG_ID} not found!`);
      console.error('[Seed] Run init-test-data.ts first to create the organization.');
      process.exit(1);
    }
    console.log(`[Seed] ✓ Organization ${DEFAULT_ORG_ID} exists`);

    // Load templates
    console.log('\n[Seed] Loading bootstrap templates...');
    const templates = await loadBootstrapTemplates();
    console.log(`[Seed] Found ${templates.length} templates`);

    if (templates.length === 0) {
      console.warn('[Seed] No templates found in bootstrap directory');
      console.log(`[Seed] Expected directory: ${BOOTSTRAP_DIR}`);
      process.exit(1);
    }

    // Seed each template
    console.log('\n[Seed] Seeding templates...');
    let successCount = 0;
    let skipCount = 0;
    let errorCount = 0;

    for (const { filename, template, source } of templates) {
      // Determine template ID
      const id = template.variant_id || template.activity_id || filename.replace('.json', '');
      const displayName = `${source}/${filename}`;

      // Check if already exists
      const existing = await db.query<any[][]>(
        `SELECT id FROM activity_registry WHERE id = $id`,
        { id }
      );

      if (existing[0] && existing[0].length > 0) {
        skipCount++;
        console.log(`  ○ ${displayName} → ${id} (already exists)`);
        continue;
      }

      // Prepare tags and prefixes
      const tags = template.tags || (template.category ? [template.category] : ['uncategorized']);
      const tagPrefixes = generateTagPrefixes(tags);

      // Get task_steps (prefer task_steps over tasks)
      let taskSteps = template.task_steps || template.tasks || [];

      // Clean task_steps - remove fields not in schema (dependencies, context_rules, etc.)
      taskSteps = taskSteps.map((step: any) => {
        const { dependencies, context_rules, ...cleanedStep } = step;
        return cleanedStep;
      });

      try {
        await db.query(
          `CREATE activity_template SET
            id = $id,
            variant_id = $id,
            activity_id = $id,
            variant_name = $name,
            description = $description,
            category = $category,
            tags = $tags,
            task_steps = $task_steps,
            scope = 'global',
            org_id = $org_id,
            created_at = time::now(),
            updated_at = time::now()`,
          {
            id,
            name: template.name,
            description: template.description,
            category: template.category || tags[0] || 'uncategorized',
            tags,
            task_steps: taskSteps,
            impulses: template.impulses || [],
            // Use record format for consistency with JWT $auth.org_id
            org_id: `organizations:${DEFAULT_ORG_ID}`,
            alpha: INITIAL_ALPHA,
          }
        );

        successCount++;
        console.log(`  ✓ ${displayName} → ${id} (α=${INITIAL_ALPHA})`);
      } catch (error) {
        errorCount++;
        console.error(`  ✗ ${displayName} → ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Summary
    console.log('\n' + '='.repeat(80));
    console.log('[Seed] Complete!');
    console.log(`  Seeded: ${successCount}`);
    console.log(`  Skipped (existing): ${skipCount}`);
    console.log(`  Errors: ${errorCount}`);
    console.log('='.repeat(80));

    if (errorCount > 0) {
      process.exit(1);
    }

  } catch (error) {
    console.error('[Seed] Fatal error:', error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

// Run seeding
seedTemplates();
