# Schema Conventions

## org_id Field Type

**Always use `TYPE string` for org_id fields.**

### Rationale

- Organization records are managed by identity-vessel (separate service)
- No true foreign key constraints across services
- String references are simpler and avoid RECORD type mismatches
- RBAC enforcement works identically with string comparison
- JWT tokens contain `org_id` as a string claim, not a record reference
- Consistent with microservices architecture where foreign keys don't span service boundaries

### Standard Pattern

```sql
DEFINE FIELD IF NOT EXISTS org_id ON table_name TYPE string
  ASSERT $value != NONE
  VALUE $value OR $auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";
```

### RBAC Enforcement

Multi-tenant isolation is enforced at the database level using PERMISSIONS clauses:

```sql
DEFINE TABLE table_name SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE
      org_id = $auth.org_id
      AND ($auth.role = 'admin' OR created_by = $auth.id)
    FOR delete WHERE
      org_id = $auth.org_id
      AND $auth.role = 'admin';
```

This works because:
- `$auth.org_id` from JWT is a string
- String comparison `org_id = $auth.org_id` is direct and efficient
- No RECORD type casting or dereferencing required
- SurrealDB enforces these rules at the query level

### Benefits of String References

1. **Cross-service references**: Organizations are managed by identity-vessel, a separate microservice
2. **No cascade issues**: Deleting an organization doesn't require cascade updates across services
3. **Simpler queries**: No need to dereference record fields like `org_id.id`
4. **JWT compatibility**: JWT claims are strings, not records
5. **Performance**: String comparison is faster than record lookup
6. **Flexibility**: Can reference organizations that exist in external systems

### Migration from record<organizations>

If you have existing schemas using `TYPE record<organizations>`, migrate them using:

```sql
-- Update field definition
DEFINE FIELD IF NOT EXISTS org_id ON table_name TYPE string
  ASSERT $value != NONE
  VALUE $value OR $auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";
```

The `IF NOT EXISTS` clause makes this idempotent and safe to re-run.

### When NOT to Use String References

Use `TYPE record<table>` only when:
- Both tables are in the same service/database
- You need to enforce referential integrity
- You need to traverse the relationship in queries (e.g., `SELECT * FROM activity WHERE org_id.name = "Metabob"`)

For cross-service references like `org_id`, `project_id` (from identity-vessel), always use `TYPE string`.

### Examples

**Correct usage:**

```sql
-- Core paradigm tables
DEFINE FIELD IF NOT EXISTS org_id ON impulse TYPE string
  ASSERT $value != NONE
  VALUE $value OR $auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS org_id ON activity TYPE string
  ASSERT $value != NONE
  VALUE $value OR $auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

-- Legacy tables
DEFINE FIELD IF NOT EXISTS org_id ON activity_registry TYPE string
  ASSERT $value != NONE
  VALUE $value OR $auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";
```

**Incorrect usage (don't do this):**

```sql
-- ❌ Don't use record type for cross-service references
DEFINE FIELD IF NOT EXISTS org_id ON table_name TYPE record<organizations>
  ASSERT $value != NONE;

-- ❌ Don't try to dereference string references
SELECT * FROM activity WHERE org_id.name = "Metabob";  -- Won't work with string type
```

### Verification

To verify all tables use string references correctly:

```sql
-- Show all tables with org_id and their types
INFO FOR DB;

-- Check specific table
INFO FOR TABLE activity;

-- Look for org_id field type (should be "string", not "record")
```

### Related Fields

The same string reference pattern applies to other cross-service references:
- `project_id`: References identity-vessel projects (use `TYPE option<string>` if nullable)
- `vessel_id`: References vessel instances (use `TYPE option<string>`)
- `user_id`: In some contexts where it references identity-vessel users

However, for same-service references like `activity_id` referencing the `activity` table within activity-api, you may use either `TYPE string` or `TYPE record<activity>` depending on whether you need relationship traversal.
