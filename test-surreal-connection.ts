#!/usr/bin/env bun
/**
 * Debug SurrealDB SDK connection
 */
import { Surreal } from 'surrealdb';

const SURREALDB_URL = process.env.SURREALDB_URL || 'http://surql.metabob.local/rpc';

console.log('Testing SurrealDB connection...');
console.log('URL:', SURREALDB_URL);

async function test() {
  const db = new Surreal();

  try {
    console.log('\n1. Connecting...');
    await db.connect(SURREALDB_URL);
    console.log('   Connected!');

    console.log('\n2. Signing in...');
    await db.signin({
      username: process.env.SURREALDB_USERNAME || 'root',
      password: process.env.SURREALDB_PASSWORD || 'surrealdb-local-dev-123',
    });
    console.log('   Signed in!');

    console.log('\n3. Using namespace/database...');
    await db.use({ namespace: 'activity-system', database: 'learning_loop' });
    console.log('   Using activity-system/learning_loop');

    console.log('\n4. Running query...');
    const result = await db.query('SELECT count() FROM organizations GROUP ALL');
    console.log('   Result:', JSON.stringify(result, null, 2));

    await db.close();
    console.log('\n✓ Connection test passed!');
  } catch (error) {
    console.error('\n✗ Error:', error);
  }
}

test();
