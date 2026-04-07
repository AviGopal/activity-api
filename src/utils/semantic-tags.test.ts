import { describe, test, expect } from 'bun:test';
import {
  extractTagPrefixes,
  calculateTagMatchQuality,
  analyzeTaskSemantics,
  extractImpliedShapes,
} from './semantic-tags';

describe('semantic-tags', () => {
  describe('extractTagPrefixes', () => {
    test('extracts development.typescript and development.scaffold for TypeScript module goals', () => {
      const tags = extractTagPrefixes('Create a TypeScript module');
      expect(tags).toContain('development.typescript');
      expect(tags).toContain('development.scaffold');
    });

    test('extracts development.scaffold for create/build goals', () => {
      const tags = extractTagPrefixes('Create a new service');
      expect(tags).toContain('development.scaffold');
      expect(tags).toContain('development');
    });

    test('extracts development.testing for test goals', () => {
      const tags = extractTagPrefixes('Add tests for the auth module');
      expect(tags).toContain('development.testing');
    });

    test('extracts development.feature and development.enhancement for feature goals', () => {
      const tags = extractTagPrefixes('Add a new login feature');
      expect(tags).toContain('development.feature');
      expect(tags).toContain('development.enhancement');
    });

    test('extracts development.exploration for codebase exploration goals', () => {
      const tags = extractTagPrefixes('Investigate the codebase structure');
      expect(tags).toContain('development.exploration');
    });

    test('extracts development.documentation for documentation goals', () => {
      const tags = extractTagPrefixes('Document the API endpoints');
      expect(tags).toContain('development.documentation');
    });

    test('extracts development tags for enhance/extend goals', () => {
      const tags = extractTagPrefixes('Enhance the user profile component');
      expect(tags).toContain('development.enhancement');
    });

    test('extracts module-related development tags', () => {
      const tags = extractTagPrefixes('Build a user authentication module');
      expect(tags).toContain('development.scaffold');
      expect(tags).toContain('development');
    });
  });

  describe('calculateTagMatchQuality', () => {
    test('matches development.typescript activity with TypeScript module goal', () => {
      const extractedTags = extractTagPrefixes('Create a TypeScript module');
      const activityTags = ['development.typescript', 'development.scaffold'];
      const quality = calculateTagMatchQuality(extractedTags, activityTags);
      expect(quality).toBeGreaterThan(0);
    });

    test('matches development.testing activity with test goals', () => {
      const extractedTags = extractTagPrefixes('Add tests for the login function');
      const activityTags = ['development.testing', 'development.quality'];
      const quality = calculateTagMatchQuality(extractedTags, activityTags);
      expect(quality).toBeGreaterThan(0);
    });

    test('matches development.feature activity with feature goals', () => {
      const extractedTags = extractTagPrefixes('Add a new feature to the module');
      const activityTags = ['development.feature', 'development.enhancement'];
      const quality = calculateTagMatchQuality(extractedTags, activityTags);
      expect(quality).toBeGreaterThan(0);
    });

    test('matches development.exploration activity with investigation goals', () => {
      const extractedTags = extractTagPrefixes('Investigate the codebase');
      const activityTags = ['development.exploration', 'development.documentation'];
      const quality = calculateTagMatchQuality(extractedTags, activityTags);
      expect(quality).toBeGreaterThan(0);
    });

    test('returns 0 for no matches', () => {
      const extractedTags = ['completely', 'unrelated'];
      const activityTags = ['development.typescript'];
      const quality = calculateTagMatchQuality(extractedTags, activityTags);
      expect(quality).toBe(0);
    });

    test('returns 0 for empty inputs', () => {
      expect(calculateTagMatchQuality([], ['development.typescript'])).toBe(0);
      expect(calculateTagMatchQuality(['development'], [])).toBe(0);
    });
  });

  describe('analyzeTaskSemantics', () => {
    test('returns development as primary intent for TypeScript module creation', () => {
      const analysis = analyzeTaskSemantics('Create a TypeScript module');
      expect(analysis.primaryIntent).toBe('development');
    });

    test('includes development in all intents for module goals', () => {
      const analysis = analyzeTaskSemantics('Build a new service module');
      expect(analysis.allIntents).toContain('development');
    });

    test('getMatchQuality helper works correctly', () => {
      const analysis = analyzeTaskSemantics('Create a TypeScript module');
      const quality = analysis.getMatchQuality(['development.typescript', 'development.scaffold']);
      expect(quality).toBeGreaterThan(0);
    });
  });

  describe('extractImpliedShapes', () => {
    test('extracts goal shape for action-oriented tasks', () => {
      const shapes = extractImpliedShapes('Create a TypeScript module');
      expect(shapes).toContain('goal');
    });

    test('extracts source_code shape for file patterns', () => {
      const shapes = extractImpliedShapes('Fix the bug in auth.ts');
      expect(shapes).toContain('source_code');
    });

    test('extracts error and trace shapes for error-related goals', () => {
      const shapes = extractImpliedShapes('Debug the authentication error');
      expect(shapes).toContain('error');
      expect(shapes).toContain('trace');
    });
  });

  describe('development activities integration', () => {
    // These tests verify the complete flow from goal to activity matching
    const developmentActivities = [
      { name: 'Create TypeScript Module', tags: ['development.typescript', 'development.scaffold'] },
      { name: 'Create Tests for Module', tags: ['development.testing', 'development.quality'] },
      { name: 'Add Feature to Existing Module', tags: ['development.feature', 'development.enhancement'] },
      { name: 'Investigate Codebase', tags: ['development.exploration', 'development.documentation'] },
    ];

    test('TypeScript module goal matches Create TypeScript Module activity', () => {
      const goal = 'Create a TypeScript module with increment and decrement functions';
      const tags = extractTagPrefixes(goal);

      const matchingActivities = developmentActivities
        .map(a => ({ name: a.name, quality: calculateTagMatchQuality(tags, a.tags) }))
        .filter(a => a.quality > 0)
        .sort((a, b) => b.quality - a.quality);

      expect(matchingActivities.length).toBeGreaterThan(0);
      expect(matchingActivities[0].name).toBe('Create TypeScript Module');
    });

    test('test creation goal matches Create Tests activity', () => {
      const goal = 'Add unit tests for the counter module';
      const tags = extractTagPrefixes(goal);

      const matchingActivities = developmentActivities
        .map(a => ({ name: a.name, quality: calculateTagMatchQuality(tags, a.tags) }))
        .filter(a => a.quality > 0)
        .sort((a, b) => b.quality - a.quality);

      expect(matchingActivities.length).toBeGreaterThan(0);
      expect(matchingActivities.some(a => a.name === 'Create Tests for Module')).toBe(true);
    });

    test('feature enhancement goal matches Add Feature activity', () => {
      const goal = 'Add a new feature to enhance the user profile';
      const tags = extractTagPrefixes(goal);

      const matchingActivities = developmentActivities
        .map(a => ({ name: a.name, quality: calculateTagMatchQuality(tags, a.tags) }))
        .filter(a => a.quality > 0)
        .sort((a, b) => b.quality - a.quality);

      expect(matchingActivities.length).toBeGreaterThan(0);
      expect(matchingActivities.some(a => a.name === 'Add Feature to Existing Module')).toBe(true);
    });

    test('codebase investigation goal matches Investigate Codebase activity', () => {
      const goal = 'Investigate the codebase to understand the architecture';
      const tags = extractTagPrefixes(goal);

      const matchingActivities = developmentActivities
        .map(a => ({ name: a.name, quality: calculateTagMatchQuality(tags, a.tags) }))
        .filter(a => a.quality > 0)
        .sort((a, b) => b.quality - a.quality);

      expect(matchingActivities.length).toBeGreaterThan(0);
      expect(matchingActivities[0].name).toBe('Investigate Codebase');
    });
  });
});
