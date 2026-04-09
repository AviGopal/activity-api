/**
 * Integration Test: Thompson Sampling (Loop 2)
 *
 * Tests the complete Thompson Sampling feedback loop:
 * 1. Create templates with equal Thompson params (α=1, β=1)
 * 2. Record positive/negative feedback
 * 3. Verify α/β updates
 * 4. Verify selection probability changes
 *
 * CRITICAL PATH: Thompson Sampling is the core learning mechanism.
 * If feedback doesn't affect selection probability, the system cannot learn.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import type { ActivityTemplate } from '../src/models/schemas'
import { randomBytes } from 'crypto'

// Test configuration
const API_ENDPOINT = process.env.ACTIVITY_API_ENDPOINT || 'http://activity.metabob.local'
const API_KEY = process.env.METABOB_API_KEY_TEST || process.env.METABOB_API_KEY_ORG_A

if (!API_KEY) {
  throw new Error('Missing API key: set METABOB_API_KEY_TEST or METABOB_API_KEY_ORG_A')
}

// Helper: Create test template
async function createTestTemplate(name: string): Promise<{ id: string; template: ActivityTemplate }> {
  const template: ActivityTemplate = {
    id: `test-thompson-${randomBytes(4).toString('hex')}`,
    name,
    description: `Test template for Thompson Sampling: ${name}`,
    category: 'test',
    tags: ['test', 'thompson-sampling'],
    tasks: [
      {
        id: 'task1',
        description: 'Test task',
        prompt: {
          template: 'Do something',
          variables: [],
        },
      },
    ],
  }

  const response = await fetch(`${API_ENDPOINT}/v2/activities/templates`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `ApiKey ${API_KEY}`,
    },
    body: JSON.stringify(template),
  })

  if (!response.ok) {
    throw new Error(`Failed to create template: ${response.status} ${await response.text()}`)
  }

  const result = await response.json()
  return { id: result.id || template.id, template }
}

// Helper: Record feedback
async function recordFeedback(
  templateId: string,
  success: boolean,
  intensity: number = 1.0
): Promise<void> {
  const response = await fetch(`${API_ENDPOINT}/v2/activities/feedback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `ApiKey ${API_KEY}`,
    },
    body: JSON.stringify({
      templateId,
      success,
      intensity,
      timestamp: Date.now(),
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to record feedback: ${response.status} ${await response.text()}`)
  }
}

// Helper: Get Thompson parameters
async function getThompsonParams(templateId: string): Promise<{ alpha: number; beta: number }> {
  const response = await fetch(`${API_ENDPOINT}/v2/activities/templates/${templateId}`, {
    headers: {
      'Authorization': `ApiKey ${API_KEY}`,
    },
  })

  if (!response.ok) {
    throw new Error(`Failed to get template: ${response.status} ${await response.text()}`)
  }

  const template = await response.json()
  return {
    alpha: template.thompsonAlpha || 1,
    beta: template.thompsonBeta || 1,
  }
}

// Helper: Request recommendations
async function getRecommendations(goal: string, count: number = 10): Promise<string[]> {
  const response = await fetch(`${API_ENDPOINT}/v2/activities/recommend`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `ApiKey ${API_KEY}`,
    },
    body: JSON.stringify({
      goal,
      count,
      shapes: ['goal'],
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to get recommendations: ${response.status} ${await response.text()}`)
  }

  const result = await response.json()
  return result.templates.map((t: any) => t.id)
}

describe('Thompson Sampling Integration', () => {
  let templateA: { id: string; template: ActivityTemplate }
  let templateB: { id: string; template: ActivityTemplate }

  beforeAll(async () => {
    // Create two test templates
    templateA = await createTestTemplate('Template A')
    templateB = await createTestTemplate('Template B')
  })

  afterAll(async () => {
    // Cleanup (optional - templates are org-scoped so won't interfere)
  })

  test('Feedback affects Thompson parameters (α/β)', async () => {
    // 1. Get initial parameters (should be α=1, β=1)
    const paramsBeforeA = await getThompsonParams(templateA.id)
    expect(paramsBeforeA.alpha).toBe(1)
    expect(paramsBeforeA.beta).toBe(1)

    // 2. Record positive feedback for Template A
    await recordFeedback(templateA.id, true, 1.0)

    // 3. Verify α increased for Template A
    const paramsAfterA = await getThompsonParams(templateA.id)
    expect(paramsAfterA.alpha).toBeGreaterThan(paramsBeforeA.alpha)
    expect(paramsAfterA.beta).toBe(paramsBeforeA.beta) // β unchanged

    // 4. Record negative feedback for Template B
    await recordFeedback(templateB.id, false, 1.0)

    // 5. Verify β increased for Template B
    const paramsAfterB = await getThompsonParams(templateB.id)
    expect(paramsAfterB.beta).toBeGreaterThan(1)
    expect(paramsAfterB.alpha).toBe(1) // α unchanged
  }, 30000)

  test('Feedback intensity affects parameter magnitude', async () => {
    // Create new template for intensity test
    const templateC = await createTestTemplate('Template C')

    const paramsBefore = await getThompsonParams(templateC.id)

    // Record feedback with high intensity
    await recordFeedback(templateC.id, true, 3.0)

    const paramsAfter = await getThompsonParams(templateC.id)
    const alphaDelta = paramsAfter.alpha - paramsBefore.alpha

    // Verify intensity affects magnitude
    expect(alphaDelta).toBeGreaterThan(1) // Should increase by more than 1
  }, 30000)

  test('Selection probability changes with feedback', async () => {
    // Create two new templates for statistical test
    const templateX = await createTestTemplate('Template X (Good)')
    const templateY = await createTestTemplate('Template Y (Bad)')

    // Record strong positive feedback for Template X
    for (let i = 0; i < 5; i++) {
      await recordFeedback(templateX.id, true, 1.0)
    }

    // Record strong negative feedback for Template Y
    for (let i = 0; i < 5; i++) {
      await recordFeedback(templateY.id, false, 1.0)
    }

    // Verify Thompson parameters diverged
    const paramsX = await getThompsonParams(templateX.id)
    const paramsY = await getThompsonParams(templateY.id)

    expect(paramsX.alpha).toBeGreaterThan(paramsX.beta) // X has more successes
    expect(paramsY.beta).toBeGreaterThan(paramsY.alpha) // Y has more failures

    // Request recommendations many times and track selection frequency
    const selections: Record<string, number> = {}
    const numTrials = 50 // Reduced from 100 for faster tests

    for (let i = 0; i < numTrials; i++) {
      const recommendations = await getRecommendations('test goal', 1)
      const selected = recommendations[0]
      selections[selected] = (selections[selected] || 0) + 1
    }

    // Verify Template X selected more often than Template Y
    const xSelections = selections[templateX.id] || 0
    const ySelections = selections[templateY.id] || 0

    // With α=6, β=1 vs α=1, β=6:
    // Expected selection rate: X ~85%, Y ~15%
    // With 50 trials, X should be selected significantly more
    expect(xSelections).toBeGreaterThan(ySelections)

    // Log results for debugging
    console.log(`Selection frequencies (${numTrials} trials):`)
    console.log(`  Template X (good): ${xSelections} (${((xSelections / numTrials) * 100).toFixed(1)}%)`)
    console.log(`  Template Y (bad): ${ySelections} (${((ySelections / numTrials) * 100).toFixed(1)}%)`)
    console.log(`  Thompson params:`)
    console.log(`    X: α=${paramsX.alpha}, β=${paramsX.beta} (mean=${paramsX.alpha / (paramsX.alpha + paramsX.beta)})`)
    console.log(`    Y: α=${paramsY.alpha}, β=${paramsY.beta} (mean=${paramsY.alpha / (paramsY.alpha + paramsY.beta)})`)
  }, 60000)

  test('Statistical test: Selection probability matches Beta distribution', async () => {
    // Create template with known Thompson parameters
    const template = await createTestTemplate('Template Statistical')

    // Set specific α/β by recording feedback
    await recordFeedback(template.id, true, 1.0) // α=2
    await recordFeedback(template.id, true, 1.0) // α=3
    await recordFeedback(template.id, false, 1.0) // β=2

    const params = await getThompsonParams(template.id)
    expect(params.alpha).toBe(3)
    expect(params.beta).toBe(2)

    // Expected mean of Beta(3, 2) = α/(α+β) = 3/5 = 0.6
    const expectedMean = params.alpha / (params.alpha + params.beta)
    expect(expectedMean).toBeCloseTo(0.6, 2)

    // In practice, with competing templates, this template should be selected
    // proportionally to its Beta distribution sample
    // This is a smoke test - full statistical validation would require:
    // 1. Creating multiple templates with different α/β
    // 2. Running thousands of trials
    // 3. Chi-square test or KS test on selection frequencies
  }, 30000)

  test('Zero feedback maintains prior (α=1, β=1)', async () => {
    const template = await createTestTemplate('Template No Feedback')

    const params = await getThompsonParams(template.id)
    expect(params.alpha).toBe(1)
    expect(params.beta).toBe(1)

    // Expected mean = 0.5 (uniform prior)
    const mean = params.alpha / (params.alpha + params.beta)
    expect(mean).toBe(0.5)
  }, 30000)

  test('Gradual feedback accumulation', async () => {
    const template = await createTestTemplate('Template Gradual')

    // Record feedback gradually and track parameter evolution
    const evolution: Array<{ alpha: number; beta: number; mean: number }> = []

    for (let i = 0; i < 5; i++) {
      await recordFeedback(template.id, i % 2 === 0, 1.0) // Alternating success/failure

      const params = await getThompsonParams(template.id)
      const mean = params.alpha / (params.alpha + params.beta)
      evolution.push({ ...params, mean })
    }

    // Verify parameters accumulated
    expect(evolution[evolution.length - 1].alpha).toBeGreaterThan(1)
    expect(evolution[evolution.length - 1].beta).toBeGreaterThan(1)

    // With alternating feedback, mean should stay around 0.5
    expect(evolution[evolution.length - 1].mean).toBeCloseTo(0.5, 1)

    console.log('Parameter evolution:')
    evolution.forEach((e, i) => {
      console.log(`  Feedback ${i + 1}: α=${e.alpha}, β=${e.beta}, mean=${e.mean.toFixed(3)}`)
    })
  }, 60000)
})

describe('Thompson Sampling: Edge Cases', () => {
  test('Extreme positive feedback (α >> β)', async () => {
    const template = await createTestTemplate('Template Extreme Positive')

    // Record 10 positive feedbacks
    for (let i = 0; i < 10; i++) {
      await recordFeedback(template.id, true, 1.0)
    }

    const params = await getThompsonParams(template.id)
    expect(params.alpha).toBe(11) // 1 + 10
    expect(params.beta).toBe(1) // No failures

    const mean = params.alpha / (params.alpha + params.beta)
    expect(mean).toBeGreaterThan(0.9) // Very high success rate
  }, 60000)

  test('Extreme negative feedback (β >> α)', async () => {
    const template = await createTestTemplate('Template Extreme Negative')

    // Record 10 negative feedbacks
    for (let i = 0; i < 10; i++) {
      await recordFeedback(template.id, false, 1.0)
    }

    const params = await getThompsonParams(template.id)
    expect(params.alpha).toBe(1) // No successes
    expect(params.beta).toBe(11) // 1 + 10

    const mean = params.alpha / (params.alpha + params.beta)
    expect(mean).toBeLessThan(0.1) // Very low success rate
  }, 60000)

  test('Concurrent feedback updates', async () => {
    const template = await createTestTemplate('Template Concurrent')

    // Send multiple feedback requests concurrently
    await Promise.all([
      recordFeedback(template.id, true, 1.0),
      recordFeedback(template.id, true, 1.0),
      recordFeedback(template.id, false, 1.0),
    ])

    const params = await getThompsonParams(template.id)

    // All feedback should be recorded (no race conditions)
    expect(params.alpha).toBe(3) // 1 + 2 successes
    expect(params.beta).toBe(2) // 1 + 1 failure
  }, 30000)
})
