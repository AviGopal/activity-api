/**
 * Manual test for impulse INSERT fix
 *
 * Tests that:
 * 1. INSERT works with root credentials (no org_id permission check)
 * 2. Duplicate IDs are handled gracefully
 */

const TEST_IMPULSE = {
  impulse_id: 'test-insert-fix-' + Date.now(),
  pointer: {
    type: 'memo',
    content: 'Test impulse content'
  },
  shape: 'test_shape',
  summary: 'Test impulse for INSERT fix',
  metadata: { source: 'manual-test' },
  org_id: 'test-org',
  budget: 100
};

async function testImpulseInsert() {
  console.log('Testing impulse INSERT operation...\n');

  const endpoint = process.env.ACTIVITY_API_URL || 'http://activity.metabob.local';
  const url = `${endpoint}/v2/impulses`;

  console.log(`Endpoint: ${url}`);
  console.log(`Impulse ID: ${TEST_IMPULSE.impulse_id}\n`);

  // Test 1: Create new impulse
  console.log('Test 1: Creating new impulse...');
  const response1 = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(TEST_IMPULSE)
  });

  const result1 = await response1.json();
  console.log(`Status: ${response1.status}`);
  console.log(`Response:`, JSON.stringify(result1, null, 2));

  if (response1.status !== 201) {
    console.error('\n❌ FAILED: Expected 201 status code');
    process.exit(1);
  }
  console.log('✅ PASSED: Impulse created successfully\n');

  // Test 2: Try to create same impulse again (should handle duplicate gracefully)
  console.log('Test 2: Attempting to create duplicate impulse...');
  const response2 = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(TEST_IMPULSE)
  });

  const result2 = await response2.json();
  console.log(`Status: ${response2.status}`);
  console.log(`Response:`, JSON.stringify(result2, null, 2));

  if (response2.status !== 201 && response2.status !== 200) {
    console.error('\n❌ FAILED: Expected 200 or 201 status code for duplicate');
    process.exit(1);
  }
  console.log('✅ PASSED: Duplicate handled gracefully\n');

  console.log('All tests passed! ✅');
}

testImpulseInsert().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
