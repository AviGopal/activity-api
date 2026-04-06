/**
 * SurrealDB Type Utilities
 *
 * Centralized utilities for handling SurrealDB-specific types, particularly
 * RecordId objects that need to be converted to strings for consistent usage.
 *
 * SurrealDB returns RecordId objects for record identifiers (e.g., "activity:abc123").
 * These objects have a toString() method but are NOT strings, which causes issues with:
 * - Map key lookups (object identity vs string equality)
 * - typeof checks (returns 'object' not 'string')
 * - JSON serialization (may not serialize as expected)
 * - Array filtering (comparing object to string fails)
 */

/**
 * RecordId-like interface for typing purposes.
 * SurrealDB RecordId objects have these properties.
 */
export interface RecordIdLike {
  tb: string; // table name
  id: string | number | object; // record id
  toString(): string;
}

/**
 * Normalizes a SurrealDB RecordId to a string.
 *
 * Handles:
 * - String input: returns as-is
 * - RecordId object: calls toString() to get "table:id" format
 * - null/undefined: returns empty string
 * - Other objects with toString: calls toString()
 * - Other values: converts via String()
 *
 * @param id - The ID to normalize (string, RecordId, or unknown)
 * @returns A string representation of the ID, or empty string if null/undefined
 *
 * @example
 * // String passthrough
 * normalizeRecordId("activity:abc123") // => "activity:abc123"
 *
 * @example
 * // RecordId object conversion
 * const recordId = { tb: "activity", id: "abc123", toString: () => "activity:abc123" }
 * normalizeRecordId(recordId) // => "activity:abc123"
 *
 * @example
 * // Null handling
 * normalizeRecordId(null) // => ""
 * normalizeRecordId(undefined) // => ""
 */
export function normalizeRecordId(id: unknown): string {
  // Handle null/undefined
  if (id == null) {
    return '';
  }

  // String passthrough
  if (typeof id === 'string') {
    return id;
  }

  // Handle objects with toString method (RecordId, etc.)
  if (typeof id === 'object' && 'toString' in id && typeof (id as { toString: unknown }).toString === 'function') {
    return (id as { toString(): string }).toString();
  }

  // Fallback: convert via String()
  return String(id);
}

/**
 * Checks if a value looks like a SurrealDB RecordId object.
 *
 * @param value - The value to check
 * @returns true if the value appears to be a RecordId object
 */
export function isRecordIdObject(value: unknown): value is RecordIdLike {
  return (
    value != null &&
    typeof value === 'object' &&
    'tb' in value &&
    'id' in value &&
    'toString' in value &&
    typeof (value as { toString: unknown }).toString === 'function'
  );
}

/**
 * Normalizes all RecordId fields in an object to strings.
 *
 * Useful for normalizing query results before returning them in API responses.
 * Only processes top-level 'id' field by default.
 *
 * @param obj - Object with potential RecordId fields
 * @param fields - Array of field names to normalize (default: ['id'])
 * @returns A new object with normalized ID fields
 */
export function normalizeRecordIds<T extends Record<string, unknown>>(
  obj: T,
  fields: string[] = ['id']
): T {
  const result = { ...obj };
  for (const field of fields) {
    if (field in result) {
      (result as Record<string, unknown>)[field] = normalizeRecordId(result[field]);
    }
  }
  return result;
}

/**
 * Extracts just the ID portion from a SurrealDB RecordId string.
 *
 * SurrealDB RecordIds are in "table:id" format. This extracts just the id part.
 *
 * @param recordId - A RecordId string like "activity:abc123"
 * @returns Just the ID portion ("abc123"), or the input if no colon found
 *
 * @example
 * extractIdFromRecordId("activity:abc123") // => "abc123"
 * extractIdFromRecordId("abc123") // => "abc123"
 */
export function extractIdFromRecordId(recordId: string): string {
  const colonIndex = recordId.indexOf(':');
  if (colonIndex === -1) {
    return recordId;
  }
  return recordId.slice(colonIndex + 1);
}

/**
 * Extracts the table name from a SurrealDB RecordId string.
 *
 * @param recordId - A RecordId string like "activity:abc123"
 * @returns The table name ("activity"), or empty string if no colon found
 *
 * @example
 * extractTableFromRecordId("activity:abc123") // => "activity"
 * extractTableFromRecordId("abc123") // => ""
 */
export function extractTableFromRecordId(recordId: string): string {
  const colonIndex = recordId.indexOf(':');
  if (colonIndex === -1) {
    return '';
  }
  return recordId.slice(0, colonIndex);
}
