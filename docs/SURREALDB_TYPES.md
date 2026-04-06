# SurrealDB Type Handling Guide

This document explains how to handle SurrealDB-specific types in the metabob-activity-api codebase, with a focus on RecordId objects.

## The RecordId Problem

SurrealDB returns **RecordId objects** for record identifiers, not plain strings. These objects look like strings in logs and JSON output but behave differently:

```typescript
// What SurrealDB returns
const result = await db.query('SELECT * FROM activity LIMIT 1');
const activity = result[0];

console.log(activity.id);           // Logs: "activity:abc123" (looks like string!)
typeof activity.id;                 // Returns: "object" (NOT "string"!)
activity.id === "activity:abc123";  // false (object vs string comparison)
```

### Why This Matters

The RecordId-as-object issue causes subtle bugs:

1. **Map key lookups fail**: `map.get(recordId)` won't match `map.get("activity:abc123")`
2. **Set operations fail**: `set.has(recordId)` won't match string values
3. **typeof checks fail**: `typeof id === 'string'` returns false
4. **Filtering fails**: Comparing RecordId to string excludes all records
5. **API responses**: Frontend expects string IDs, not objects

### The Bug We Fixed

The `/v2/activities/recommend` endpoint was returning 0 recommendations despite 27 activities in the database. The root cause:

```typescript
// BUG: RecordId objects don't match string keys in Map
const scoresMap = new Map<string, Score>();
scoresMap.set("activity:abc123", score);

// Later, when looking up scores:
const rawId = template.id;  // This is a RecordId OBJECT
const score = scoresMap.get(rawId);  // undefined! Object key != string key
```

## The Solution: normalizeRecordId

Use the `normalizeRecordId()` utility from `src/utils/surrealdb-types.ts`:

```typescript
import { normalizeRecordId } from '../utils/surrealdb-types';

// Convert any ID (string, RecordId, null) to a string
const activityId = normalizeRecordId(template.id);
const score = scoresMap.get(activityId);  // Works!
```

### Available Utilities

```typescript
// Main utility - converts RecordId to string
normalizeRecordId(id: unknown): string

// Check if something is a RecordId object
isRecordIdObject(value: unknown): boolean

// Normalize multiple fields in an object
normalizeRecordIds(obj, ['id', 'variant_id']): obj

// Extract just the ID portion (without table prefix)
extractIdFromRecordId("activity:abc123")  // => "abc123"

// Extract just the table name
extractTableFromRecordId("activity:abc123")  // => "activity"
```

## When to Use normalizeRecordId

### Always use it when:

1. **Building Map keys** from database results:
   ```typescript
   const id = normalizeRecordId(result.id);
   scoresMap.set(id, score);
   ```

2. **Looking up in Maps/Sets**:
   ```typescript
   const id = normalizeRecordId(template.id);
   const score = scoresMap.get(id);
   ```

3. **Filtering by ID**:
   ```typescript
   const filtered = templates.filter(t => {
     const id = normalizeRecordId(t.id);
     return !excludeSet.has(id);
   });
   ```

4. **Returning IDs in API responses**:
   ```typescript
   return {
     template_id: normalizeRecordId(template.id),
     template_name: template.name,
   };
   ```

5. **Validating ID presence**:
   ```typescript
   const id = normalizeRecordId(template.id);
   if (!id || id.trim() === '') {
     // Invalid template
   }
   ```

### You don't need it when:

- The ID is already a string (e.g., from API request body)
- Passing to SurrealDB queries (it accepts both formats)
- Logging (toString() is called automatically)

## Common Patterns

### Processing Query Results

```typescript
const results = await db.query<Activity[]>('SELECT * FROM activity');

// Normalize IDs before processing
const activities = results.map(r => ({
  ...r,
  id: normalizeRecordId(r.id),
}));
```

### Building Score Maps

```typescript
// Get IDs as strings for consistent Map keys
const activityIds = templates.map(t => normalizeRecordId(t.id));

// Build Map with string keys
const scoresMap = new Map<string, Score>();
for (const score of scoresResult) {
  scoresMap.set(normalizeRecordId(score.activity_id), score);
}

// Lookup with normalized ID
const score = scoresMap.get(normalizeRecordId(template.id));
```

### API Response Construction

```typescript
const recommendations = templates.map(template => ({
  template_id: normalizeRecordId(template.id),  // Must be string in response
  template_name: template.name,
  // ...
}));
```

## Testing for RecordId Issues

The `src/utils/surrealdb-types.test.ts` file includes tests that catch these issues:

```typescript
test('Map key lookups work with normalized IDs', () => {
  const scores = new Map<string, Score>();
  scores.set('activity:abc123', { alpha: 10, beta: 2 });

  // Simulate RecordId from DB
  const mockRecordId = {
    tb: 'activity',
    id: 'abc123',
    toString: () => 'activity:abc123',
  };

  // Without normalization: undefined (BUG)
  // With normalization: works!
  const normalizedId = normalizeRecordId(mockRecordId);
  expect(scores.get(normalizedId)).toBeDefined();
});
```

## CI/CD Validation

The deploy-canary workflow includes endpoint validation that catches RecordId bugs:

```yaml
- name: Validate activity-api endpoints
  run: |
    # Verify template_id is a string, not an object
    FIRST_ID_TYPE=$(echo "$RECS" | jq -r '.recommendations[0].template_id | type')
    if [ "$FIRST_ID_TYPE" != "string" ]; then
      echo "❌ template_id is '$FIRST_ID_TYPE' instead of 'string'"
      exit 1
    fi
```

## RecordId Object Structure

For reference, SurrealDB RecordId objects have this structure:

```typescript
interface RecordId {
  tb: string;     // Table name (e.g., "activity")
  id: string | number | object;  // Record ID (e.g., "abc123")
  toString(): string;  // Returns "table:id" format
}
```

## Summary

1. **SurrealDB returns RecordId objects, not strings**
2. **Always use `normalizeRecordId()` when working with IDs from the database**
3. **Test your Map/Set operations with mock RecordId objects**
4. **CI validates that API responses have string IDs**
