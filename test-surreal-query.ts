#!/usr/bin/env bun

import { Surreal } from 'surrealdb';

const db = new Surreal();

try {
  console.log('Connecting to SurrealDB...');
  await db.connect('http://localhost:8000');

  console.log('Signing in...');
  await db.signin({
    username: 'root',
    password: 'surrealdb-local-dev-123',
  });

  console.log('Using namespace and database...');
  await db.use({
    namespace: 'activity-system',
    database: 'learning_loop',
  });

  // Test 1: Count all records
  console.log('\n=== Test 1: Count all records ===');
  const countResult = await db.query('SELECT count() as total FROM activity_execution_traces GROUP ALL');
  console.log('Count result:', JSON.stringify(countResult, null, 2));

  // Test 2: Select all records (limit 5)
  console.log('\n=== Test 2: Select all records (limit 5) ===');
  const allResult = await db.query('SELECT * FROM activity_execution_traces LIMIT 5');
  console.log('All records result:', JSON.stringify(allResult, null, 2));

  // Test 3: Select by execution_id
  console.log('\n=== Test 3: Select by execution_id ===');
  const byIdResult = await db.query(
    'SELECT * FROM activity_execution_traces WHERE execution_id = $execution_id LIMIT 1',
    { execution_id: 'test_debug_002' }
  );
  console.log('By ID result:', JSON.stringify(byIdResult, null, 2));

  // Test 4: Select by ID directly
  console.log('\n=== Test 4: Select by record ID ===');
  const byRecordId = await db.query(
    'SELECT * FROM activity_execution_traces:j6rswthpnce9d68w9w8n'
  );
  console.log('By record ID result:', JSON.stringify(byRecordId, null, 2));

  await db.close();
  console.log('\nConnection closed');
} catch (error) {
  console.error('Error:', error);
  process.exit(1);
}
