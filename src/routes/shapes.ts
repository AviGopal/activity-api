/**
 * Shape Registry Routes
 *
 * SPEC: openspec/changes/vessel-integration-standardization/specs/shape-registry/spec.md
 *
 * Provides versioned shape definitions for impulse validation and vessel-to-vessel communication.
 * Implements semantic versioning with backward compatibility tracking.
 */

import { Hono } from 'hono';
import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import { getJwtAuthFromContext } from '../middleware/jwtAuth';
import Ajv from 'ajv';

const app = new Hono();
const ajv = new Ajv({ strict: false });

// =============================================================================
// TYPES
// =============================================================================

interface ShapeDefinition {
  id?: string;
  name: string;
  version: string;
  schema: object;
  description: string;
  example: object;
  tags?: string[];
  public?: boolean;
  org_id?: string | null;
  deprecated?: boolean;
  deprecation_reason?: string | null;
  migration_from?: string | null;
  breaking_changes?: string[];
  changelog?: string | null;
  created_at?: string;
  created_by?: string | null;
}

interface ShapeVersionInfo {
  version: string;
  created_at: string;
  breaking_changes: string[];
  deprecated: boolean;
  deprecation_reason?: string | null;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Parse semantic version string into components
 */
function parseSemver(version: string): { major: number; minor: number; patch: number } | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

/**
 * Compare two semantic versions
 * Returns: -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2
 */
function compareSemver(v1: string, v2: string): number {
  const p1 = parseSemver(v1);
  const p2 = parseSemver(v2);
  if (!p1 || !p2) return 0;

  if (p1.major !== p2.major) return p1.major - p2.major;
  if (p1.minor !== p2.minor) return p1.minor - p2.minor;
  return p1.patch - p2.patch;
}

/**
 * Check if version matches semver constraint
 * Supports: exact (1.2.3), caret (^1.2.0), tilde (~1.2.0), wildcard (1.x)
 */
function matchesConstraint(version: string, constraint: string): boolean {
  // Exact version
  if (!constraint.includes('^') && !constraint.includes('~') && !constraint.includes('x')) {
    return version === constraint;
  }

  const vParsed = parseSemver(version);
  if (!vParsed) return false;

  // Caret (^1.2.0 allows >=1.2.0 <2.0.0)
  if (constraint.startsWith('^')) {
    const cParsed = parseSemver(constraint.substring(1));
    if (!cParsed) return false;
    return (
      vParsed.major === cParsed.major &&
      (vParsed.minor > cParsed.minor ||
        (vParsed.minor === cParsed.minor && vParsed.patch >= cParsed.patch))
    );
  }

  // Tilde (~1.2.0 allows >=1.2.0 <1.3.0)
  if (constraint.startsWith('~')) {
    const cParsed = parseSemver(constraint.substring(1));
    if (!cParsed) return false;
    return (
      vParsed.major === cParsed.major &&
      vParsed.minor === cParsed.minor &&
      vParsed.patch >= cParsed.patch
    );
  }

  // Wildcard (1.x allows any 1.x.x)
  if (constraint.includes('x')) {
    const parts = constraint.split('.');
    if (parts[0] !== 'x' && parseInt(parts[0], 10) !== vParsed.major) return false;
    if (parts[1] !== 'x' && parts[1] !== undefined && parseInt(parts[1], 10) !== vParsed.minor)
      return false;
    return true;
  }

  return false;
}

/**
 * Validate JSON schema syntax
 */
function isValidJsonSchema(schema: any): boolean {
  try {
    ajv.compile(schema);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Validate example against schema
 */
function validateExample(example: any, schema: any): { valid: boolean; error?: string } {
  try {
    const validate = ajv.compile(schema);
    const valid = validate(example);
    if (!valid) {
      return {
        valid: false,
        error: ajv.errorsText(validate.errors),
      };
    }
    return { valid: true };
  } catch (error: any) {
    return { valid: false, error: error.message };
  }
}

// =============================================================================
// ROUTES
// =============================================================================

/**
 * POST /v2/shapes
 *
 * Register new shape definition with validation.
 * Supports both JWT and API key authentication.
 */
app.post('/', async (c) => {
  const auth = getJwtAuthFromContext(c);
  if (!auth) {
    return c.json({ error: 'Authentication required (JWT or API key)' }, 401);
  }

  let body: Partial<ShapeDefinition>;
  try {
    body = await c.req.json();
  } catch (error) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // Validate required fields
  if (!body.name || !body.version || !body.schema || !body.description || !body.example) {
    return c.json({
      error: 'Missing required fields',
      details: 'name, version, schema, description, and example are required',
    }, 400);
  }

  // Validate semver format
  if (!parseSemver(body.version)) {
    return c.json({
      error: 'Invalid version format',
      details: 'Version must follow semver format (MAJOR.MINOR.PATCH)',
    }, 400);
  }

  // Validate JSON schema syntax
  if (!isValidJsonSchema(body.schema)) {
    return c.json({ error: 'Invalid JSON schema syntax' }, 400);
  }

  // Validate example against schema
  const exampleValidation = validateExample(body.example, body.schema);
  if (!exampleValidation.valid) {
    return c.json({
      error: 'Example must validate against schema',
      details: exampleValidation.error,
    }, 400);
  }

  try {
    // Check if this version already exists
    const existingQuery = `
      SELECT id FROM shape_definition
      WHERE name = $name AND version = $version
      LIMIT 1;
    `;
    const existing = await surrealDB.query<{ id: string }[]>(existingQuery, {
      name: body.name,
      version: body.version,
    });

    if (existing[0]?.length > 0) {
      return c.json({
        error: 'Version already exists',
        details: `Shape ${body.name} version ${body.version} is already registered`,
      }, 409);
    }

    // Check for version downgrade (cannot register older version than latest)
    const latestQuery = `
      SELECT version FROM shape_definition
      WHERE name = $name
      ORDER BY version DESC
      LIMIT 1;
    `;
    const latest = await surrealDB.query<{ version: string }[]>(latestQuery, {
      name: body.name,
    });

    if (latest[0]?.length > 0) {
      const latestVersion = latest[0][0].version;
      if (compareSemver(body.version, latestVersion) < 0) {
        return c.json({
          error: 'Cannot register older version',
          details: `Latest version is ${latestVersion}, cannot register ${body.version}`,
        }, 400);
      }
    }

    // Create shape definition
    const createQuery = `
      CREATE shape_definition CONTENT {
        name: $name,
        version: $version,
        schema: $schema,
        description: $description,
        example: $example,
        tags: $tags,
        public: $public,
        org_id: $orgId,
        deprecated: false,
        breaking_changes: $breaking_changes,
        changelog: $changelog,
        migration_from: $migration_from,
        created_at: time::now(),
        created_by: $userId
      }
      RETURN id, name, version, created_at;
    `;

    const results = await surrealDB.query<ShapeDefinition[]>(createQuery, {
      name: body.name,
      version: body.version,
      schema: body.schema,
      description: body.description,
      example: body.example,
      tags: body.tags || [],
      public: body.public !== undefined ? body.public : false,
      orgId: body.public ? null : auth.orgId,
      breaking_changes: body.breaking_changes || [],
      changelog: body.changelog || null,
      migration_from: body.migration_from || null,
      userId: (auth as any).userId || null,
    });

    const result = results[0]?.[0];
    if (!result) {
      throw new Error('Failed to create shape definition');
    }

    logger.info('Shape registered', {
      name: body.name,
      version: body.version,
      public: body.public,
      orgId: auth.orgId,
    });

    return c.json(
      {
        id: result.id,
        name: result.name,
        version: result.version,
        created_at: result.created_at,
      },
      201
    );
  } catch (error) {
    const err = error as Error;
    logger.error('Shape registration failed', {
      name: body.name,
      version: body.version,
      error: err.message,
    });
    return c.json({ error: 'Failed to register shape', details: err.message }, 500);
  }
});

/**
 * GET /v2/shapes/:name
 *
 * Get shape definition by name and optional version constraint.
 * Supports both JWT and API key authentication.
 */
app.get('/:name', async (c) => {
  const auth = getJwtAuthFromContext(c);
  if (!auth) {
    return c.json({ error: 'Authentication required (JWT or API key)' }, 401);
  }

  const name = c.req.param('name');
  const versionConstraint = c.req.query('version');

  try {
    // Get all versions of this shape accessible to user
    const query = `
      SELECT * FROM shape_definition
      WHERE name = $name
        AND (public = true OR org_id IS NONE OR org_id = $orgId)
      ORDER BY version DESC;
    `;

    const shapes = await surrealDB.query<ShapeDefinition[]>(query, {
      name,
      orgId: auth.orgId,
    });

    if (shapes[0]?.length === 0) {
      return c.json({ error: 'Shape not found', name }, 404);
    }

    // Filter by version constraint if provided
    let selectedShape: ShapeDefinition | undefined;

    if (versionConstraint) {
      selectedShape = shapes[0].find((s) => matchesConstraint(s.version, versionConstraint));
      if (!selectedShape) {
        return c.json({
          error: 'No version matches constraint',
          constraint: versionConstraint,
          available: shapes[0].map((s) => s.version),
        }, 400);
      }
    } else {
      // Return latest version (first after ORDER BY version DESC)
      selectedShape = shapes[0][0];
    }

    return c.json(selectedShape);
  } catch (error) {
    const err = error as Error;
    logger.error('Get shape failed', {
      name,
      versionConstraint,
      error: err.message,
    });
    return c.json({ error: 'Failed to get shape', details: err.message }, 500);
  }
});

/**
 * GET /v2/shapes/:name/versions
 *
 * List all versions of a shape.
 * Supports both JWT and API key authentication.
 */
app.get('/:name/versions', async (c) => {
  const auth = getJwtAuthFromContext(c);
  if (!auth) {
    return c.json({ error: 'Authentication required (JWT or API key)' }, 401);
  }

  const name = c.req.param('name');

  try {
    const query = `
      SELECT version, created_at, breaking_changes, deprecated, deprecation_reason
      FROM shape_definition
      WHERE name = $name
        AND (public = true OR org_id IS NONE OR org_id = $orgId)
      ORDER BY version DESC;
    `;

    const versions = await surrealDB.query<ShapeVersionInfo[]>(query, {
      name,
      orgId: auth.orgId,
    });

    if (versions[0]?.length === 0) {
      return c.json({ error: 'Shape not found', name }, 404);
    }

    return c.json({
      name,
      versions: versions[0],
    });
  } catch (error) {
    const err = error as Error;
    logger.error('List shape versions failed', {
      name,
      error: err.message,
    });
    return c.json({ error: 'Failed to list versions', details: err.message }, 500);
  }
});

/**
 * GET /v2/shapes
 *
 * List all accessible shapes (latest version only).
 * Supports both JWT and API key authentication.
 */
app.get('/', async (c) => {
  const auth = getJwtAuthFromContext(c);
  if (!auth) {
    return c.json({ error: 'Authentication required (JWT or API key)' }, 401);
  }

  const tag = c.req.query('tag');
  const publicOnly = c.req.query('public_only') === 'true';

  try {
    let query = `
      SELECT name, version, description, tags, public, created_at
      FROM shape_definition
      WHERE (public = true OR org_id IS NONE OR org_id = $orgId)
    `;

    if (publicOnly) {
      query += ' AND public = true';
    }

    if (tag) {
      query += ' AND $tag IN tags';
    }

    query += ' ORDER BY name ASC, version DESC;';

    const shapes = await surrealDB.query<ShapeDefinition[]>(query, {
      orgId: auth.orgId,
      tag,
    });

    // Group by name and keep only latest version
    const latestShapes = new Map<string, ShapeDefinition>();
    for (const shape of shapes[0] || []) {
      if (!latestShapes.has(shape.name)) {
        latestShapes.set(shape.name, shape);
      }
    }

    return c.json({
      shapes: Array.from(latestShapes.values()),
    });
  } catch (error) {
    const err = error as Error;
    logger.error('List shapes failed', { error: err.message });
    return c.json({ error: 'Failed to list shapes', details: err.message }, 500);
  }
});

/**
 * GET /v2/shapes/:name/migrations
 *
 * Get migration path between versions.
 * Supports both JWT and API key authentication.
 */
app.get('/:name/migrations', async (c) => {
  const auth = getJwtAuthFromContext(c);
  if (!auth) {
    return c.json({ error: 'Authentication required (JWT or API key)' }, 401);
  }

  const name = c.req.param('name');
  const fromVersion = c.req.query('from');
  const toVersion = c.req.query('to');

  if (!fromVersion || !toVersion) {
    return c.json({
      error: 'Missing required query parameters',
      details: 'from and to version parameters are required',
    }, 400);
  }

  try {
    // Get target version
    const query = `
      SELECT breaking_changes, changelog, migration_from
      FROM shape_definition
      WHERE name = $name
        AND version = $toVersion
        AND (public = true OR org_id IS NONE OR org_id = $orgId)
      LIMIT 1;
    `;

    const results = await surrealDB.query<ShapeDefinition[]>(query, {
      name,
      toVersion,
      orgId: auth.orgId,
    });

    if (results[0]?.length === 0) {
      return c.json({ error: 'Target version not found' }, 404);
    }

    const targetShape = results[0][0];

    // For now, return basic migration info
    // In the future, this could traverse migration_from to build full path
    return c.json({
      from: fromVersion,
      to: toVersion,
      breaking_changes: targetShape.breaking_changes || [],
      migration_steps: [
        'Review breaking changes listed above',
        'Update impulse creation code to match new schema',
        `Consult shape documentation for ${name} version ${toVersion}`,
      ],
      changelog: targetShape.changelog,
    });
  } catch (error) {
    const err = error as Error;
    logger.error('Get migration path failed', {
      name,
      fromVersion,
      toVersion,
      error: err.message,
    });
    return c.json({ error: 'Failed to get migration path', details: err.message }, 500);
  }
});

export default app;
