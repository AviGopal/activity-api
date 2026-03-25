#!/usr/bin/env bun
/**
 * Test script to initialize and validate the unified activity model
 */

import { surrealDB } from './src/db/surreal';

async function main() {
  console.log('Testing unified activity model...\n');

  // Create activity_registry table
  console.log('1. Creating activity_registry table...');
  await surrealDB.query(`
    DEFINE TABLE activity_registry SCHEMAFULL;
    DEFINE FIELD id ON activity_registry TYPE string;
    DEFINE FIELD name ON activity_registry TYPE string;
    DEFINE FIELD description ON activity_registry TYPE string;
    DEFINE FIELD execution_format ON activity_registry TYPE string;
    DEFINE FIELD source_location ON activity_registry TYPE option<object>;
    DEFINE FIELD intent ON activity_registry TYPE option<object>;
    DEFINE FIELD executions ON activity_registry TYPE int VALUE \$value OR 0;
    DEFINE FIELD successes ON activity_registry TYPE int VALUE \$value OR 0;
    DEFINE FIELD failures ON activity_registry TYPE int VALUE \$value OR 0;
    DEFINE FIELD alpha ON activity_registry TYPE float VALUE \$value OR 1.0;
    DEFINE FIELD beta ON activity_registry TYPE float VALUE \$value OR 1.0;
    DEFINE FIELD vessel_id ON activity_registry TYPE option<string>;
    DEFINE INDEX idx_activity_id ON activity_registry FIELDS id UNIQUE;
  `);
  console.log('✓ Table created\n');

  // Insert a test vessel-function activity
  console.log('2. Inserting test vessel-function activity...');
  const testActivity = {
    id: 'test-vessel:testFunction',
    name: 'testFunction',
    description: 'Test function for unified model validation',
    execution_format: 'vessel-function',
    source_location: {
      vesselId: 'vessel_test_123',
      file: 'test.ts',
      line: 10,
      functionName: 'testFunction',
    },
    intent: {
      purpose: 'Validate unified activity model',
      confidence: 0.9,
      source: 'docstring',
    },
    executions: 0,
    successes: 0,
    failures: 0,
    alpha: 1.0,
    beta: 1.0,
    vessel_id: 'vessel_test_123',
  };

  await surrealDB.query(`INSERT INTO activity_registry $activity`, {
    activity: testActivity,
  });
  console.log('✓ Test activity inserted\n');

  // Query it back
  console.log('3. Querying vessel-function activities...');
  const result = await surrealDB.query<any>(`
    SELECT * FROM activity_registry
    WHERE execution_format = 'vessel-function'
  `);
  console.log(`Found ${result?.length || 0} vessel-function activities`);
  if (result && result.length > 0) {
    console.log(JSON.stringify(result[0], null, 2));
  }
  console.log('\n✓ Unified activity model validated!');
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
