/**
 * Tag utilities for hierarchical activity classification
 *
 * Tags use dot-notation for hierarchy:
 *   feature.vessel.state.communication
 *   utility.code.trace.cpg
 *   meta.develop.activity
 */

/**
 * Valid tag pattern: lowercase alphanumeric segments separated by dots
 * Each segment must start with a letter
 */
export const TAG_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/;

/**
 * Legacy category values that can be auto-converted to tags
 */
export const LEGACY_CATEGORIES = [
  'feature',
  'bugfix',
  'refactor',
  'tool',
  'infrastructure',
  'meta',
] as const;

export type LegacyCategory = typeof LEGACY_CATEGORIES[number];

/**
 * Check if a string is a valid tag
 */
export function isValidTag(tag: string): boolean {
  return TAG_PATTERN.test(tag) && tag.length <= 100;
}

/**
 * Validate an array of tags
 */
export function validateTags(tags: string[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (tags.length === 0) {
    errors.push('At least one tag is required');
  }

  if (tags.length > 10) {
    errors.push('Maximum 10 tags allowed');
  }

  for (const tag of tags) {
    if (!isValidTag(tag)) {
      errors.push(`Invalid tag format: "${tag}" (must be lowercase alphanumeric with dots, e.g., "feature.vessel.state")`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Convert a legacy category to a tag array
 */
export function categoryToTags(category: string): string[] {
  // If it's a legacy category, just wrap it
  if (LEGACY_CATEGORIES.includes(category as LegacyCategory)) {
    return [category];
  }

  // If it looks like a tag already, return as-is
  if (isValidTag(category)) {
    return [category];
  }

  // Default fallback
  return ['uncategorized'];
}

/**
 * Ensure we have tags, converting from category if needed
 */
export function ensureTags(input: { tags?: string[]; category?: string }): string[] {
  // If tags are provided and non-empty, use them
  if (input.tags && input.tags.length > 0) {
    return input.tags;
  }

  // Fall back to converting category
  if (input.category) {
    return categoryToTags(input.category);
  }

  // Default
  return ['uncategorized'];
}

/**
 * Compute all prefixes for a set of tags
 *
 * Example:
 *   ["feature.vessel.state", "utility.code"] ->
 *   ["feature", "feature.vessel", "feature.vessel.state", "utility", "utility.code"]
 */
export function computeTagPrefixes(tags: string[]): string[] {
  const prefixes = new Set<string>();

  for (const tag of tags) {
    const parts = tag.split('.');
    for (let i = 1; i <= parts.length; i++) {
      prefixes.add(parts.slice(0, i).join('.'));
    }
  }

  return Array.from(prefixes).sort();
}

/**
 * Derive a category from tags (for backward compatibility)
 * Returns the first segment of the first tag
 */
export function deriveCategory(tags: string[]): string | null {
  if (tags.length === 0) return null;

  const firstTag = tags[0];
  const firstSegment = firstTag.split('.')[0];

  // Only return if it's a known legacy category
  if (LEGACY_CATEGORIES.includes(firstSegment as LegacyCategory)) {
    return firstSegment;
  }

  return null;
}

/**
 * Normalize tags: lowercase, deduplicate, sort
 */
export function normalizeTags(tags: string[]): string[] {
  const normalized = tags.map(t => t.toLowerCase().trim());
  const unique = [...new Set(normalized)];
  return unique.sort();
}
