#!/usr/bin/env bun
/**
 * Thompson Sampling Learning Validation
 *
 * Verifies that the shape match scoring and Thompson Sampling update
 * functions work correctly and produce expected learning behavior.
 */

import {
  computeShapeMatchScore,
  computeWeightedSuccessScore,
  computeThompsonSamplingUpdates,
  extractOutputShapes,
  validateOutputShapes,
} from "./src/services/thompson-sampling";

console.log("🚀 Thompson Sampling Learning Validation\n");
console.log("=".repeat(60));

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`✅ ${message}`);
    passed++;
  } else {
    console.log(`❌ ${message}`);
    failed++;
  }
}

function almostEqual(a: number, b: number, epsilon = 0.01): boolean {
  return Math.abs(a - b) < epsilon;
}

// Test 1: Shape Match Scoring (Jaccard Similarity)
console.log("\n📊 Test 1: Shape Match Scoring (Jaccard Similarity)\n");

const test1a = computeShapeMatchScore(
  ["source_code", "test_file"],
  ["source_code", "test_file"]
);
assert(test1a === 1.0, `Perfect match: ${test1a} === 1.0`);

const test1b = computeShapeMatchScore(
  ["source_code", "test_file"],
  ["source_code", "documentation"]
);
// intersection: [source_code] = 1, union: 3 shapes = 0.333...
assert(almostEqual(test1b, 0.333, 0.01), `Partial match: ${test1b} ≈ 0.33`);

const test1c = computeShapeMatchScore(
  ["source_code"],
  ["documentation"]
);
assert(test1c === 0.0, `No match: ${test1c} === 0.0`);

const test1d = computeShapeMatchScore([], []);
assert(test1d === 1.0, `Empty arrays (both empty = perfect match): ${test1d} === 1.0`);

// Test 2: Weighted Success Scoring
console.log("\n📈 Test 2: Weighted Success Scoring\n");

const test2a = computeWeightedSuccessScore(true, 1.0);
// success with perfect match: 0.7 * 1.0 + 0.3 = 1.0
assert(test2a === 1.0, `Success + perfect match: ${test2a} === 1.0`);

const test2b = computeWeightedSuccessScore(true, 0.5);
// success with partial match: 0.7 * 0.5 + 0.3 = 0.65
assert(almostEqual(test2b, 0.65), `Success + partial match: ${test2b} ≈ 0.65`);

const test2c = computeWeightedSuccessScore(true, 0.0);
// success with no match: 0.7 * 0.0 + 0.3 = 0.3
assert(almostEqual(test2c, 0.3), `Success + no match: ${test2c} ≈ 0.30`);

const test2d = computeWeightedSuccessScore(false, 1.0);
assert(test2d === 0.0, `Failure (any match): ${test2d} === 0.0`);

// Test 3: Thompson Sampling Updates
console.log("\n🎲 Test 3: Thompson Sampling Parameter Updates\n");

const test3a = computeThompsonSamplingUpdates(true, 1.0);
assert(test3a.alphaDelta === 1.0, `Perfect score α: ${test3a.alphaDelta} === 1.0`);
assert(test3a.betaDelta === 0.0, `Perfect score β: ${test3a.betaDelta} === 0.0`);

const test3b = computeThompsonSamplingUpdates(true, 0.5);
// 0.7 * 0.5 + 0.3 = 0.65
assert(almostEqual(test3b.alphaDelta, 0.65), `Partial score α: ${test3b.alphaDelta} ≈ 0.65`);
assert(almostEqual(test3b.betaDelta, 0.35), `Partial score β: ${test3b.betaDelta} ≈ 0.35`);

const test3c = computeThompsonSamplingUpdates(false, 0.0);
assert(test3c.alphaDelta === 0.0, `Zero score α: ${test3c.alphaDelta} === 0.0`);
assert(test3c.betaDelta === 1.0, `Zero score β: ${test3c.betaDelta} === 1.0`);

// Test 4: Output Shape Extraction
console.log("\n🔍 Test 4: Output Shape Extraction\n");

const test4a = extractOutputShapes({
  output_impulses: [
    { shape: "source_code", impulse_id: "imp1", pointer: { type: "file", path: "test.ts" } },
    { shape: "test_file", impulse_id: "imp2", pointer: { type: "file", path: "test.test.ts" } },
  ],
});
assert(
  test4a.length === 2 && test4a.includes("source_code") && test4a.includes("test_file"),
  `Extract from output_impulses: [${test4a.join(", ")}]`
);

const test4b = extractOutputShapes({
  output_impulse_shapes: ["documentation", "config_file"],
});
assert(
  test4b.length === 2 && test4b.includes("documentation") && test4b.includes("config_file"),
  `Extract from output_impulse_shapes: [${test4b.join(", ")}]`
);

// Test 5: Output Shape Validation
console.log("\n✓ Test 5: Output Shape Validation\n");

const test5a = validateOutputShapes(
  ["source_code", "test_file"],
  ["source_code", "test_file"],
  true
);
assert(
  test5a.passed && test5a.shapeMatchScore === 1.0,
  `Perfect match passes validation: passed=${test5a.passed}, score=${test5a.shapeMatchScore}`
);

const test5b = validateOutputShapes(
  ["source_code"],
  ["source_code", "documentation", "test_file"],
  true
);
// intersection: 1, union: 3, score: 0.33 < 0.8
assert(
  !test5b.passed && almostEqual(test5b.shapeMatchScore, 0.333, 0.01),
  `Low match fails validation: passed=${test5b.passed}, score=${test5b.shapeMatchScore.toFixed(2)}`
);

const test5c = validateOutputShapes(
  ["source_code", "documentation"],
  ["source_code", "test_file"],
  true
);
// intersection: 1, union: 3, score: 0.33 < 0.8
assert(
  !test5c.passed,
  `Below threshold fails: passed=${test5c.passed}, score=${test5c.shapeMatchScore.toFixed(2)}`
);

// Test 6: End-to-End Learning Scenario
console.log("\n🔬 Test 6: End-to-End Learning Scenario\n");

// Simulate template with 80% success rate, good shape matches
let alpha = 1.0;
let beta = 1.0;

const executions = [
  { success: true, shapes: ["source_code", "test_file"] }, // expected: [source_code, test_file]
  { success: true, shapes: ["source_code", "test_file"] },
  { success: true, shapes: ["source_code"] }, // partial match
  { success: false, shapes: [] },
  { success: true, shapes: ["source_code", "test_file"] },
  { success: true, shapes: ["source_code", "documentation"] }, // partial
  { success: false, shapes: [] },
  { success: true, shapes: ["source_code", "test_file"] },
  { success: true, shapes: ["source_code", "test_file"] },
  { success: true, shapes: ["source_code", "test_file"] },
];

const expectedShapes = ["source_code", "test_file"];

executions.forEach((exec, i) => {
  const shapeMatch = computeShapeMatchScore(expectedShapes, exec.shapes);
  const weightedScore = computeWeightedSuccessScore(exec.success, shapeMatch);
  const { alphaDelta, betaDelta } = computeThompsonSamplingUpdates(exec.success, shapeMatch);

  alpha += alphaDelta;
  beta += betaDelta;

  console.log(
    `Execution ${i + 1}: success=${exec.success}, shapes=${exec.shapes.length}, ` +
    `match=${shapeMatch.toFixed(2)}, weighted=${weightedScore.toFixed(2)}, ` +
    `α=${alpha.toFixed(2)}, β=${beta.toFixed(2)}`
  );
});

// Expected behavior:
// - Alpha should be significantly higher than beta (more successes)
// - Success rate: 80% (8/10)
// - Average match score ~0.8
// - Alpha ≈ 7-8, Beta ≈ 3-4

assert(alpha > beta, `Alpha (${alpha.toFixed(2)}) > Beta (${beta.toFixed(2)}) after learning`);
assert(alpha > 6.0, `Alpha increased significantly: ${alpha.toFixed(2)} > 6.0`);
assert(beta < 5.0, `Beta remained low: ${beta.toFixed(2)} < 5.0`);

const meanEstimate = alpha / (alpha + beta);
assert(
  meanEstimate > 0.6 && meanEstimate < 0.9,
  `Estimated success rate ${(meanEstimate * 100).toFixed(1)}% in expected range (60-90%)`
);

// Summary
console.log("\n" + "=".repeat(60));
console.log("\n📊 Test Summary\n");
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total:  ${passed + failed}`);
console.log(`Success Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%\n`);

if (failed === 0) {
  console.log("✨ All tests passed! Thompson Sampling is learning correctly.\n");
  process.exit(0);
} else {
  console.log("⚠️  Some tests failed. Review the output above.\n");
  process.exit(1);
}
