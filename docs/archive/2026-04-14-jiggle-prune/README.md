# Documentation Archive: 2026-04-14 Jiggle-and-Prune

**Date**: 2026-04-14
**Operation**: Jiggle-and-prune documentation cleanup
**Reason**: Point-in-time verification documents and completed implementation guides archived

## Archived Documents

### Verification Reports (Completed)

1. **VERIFICATION_REPORT.md** (2026-04-08)
   - API key authentication and ACL enforcement verification
   - Status: Completed and validated
   - Archive reason: Verification complete, implementation is stable

2. **FEEDBACK_ENDPOINT_VERIFICATION.md** (2026-04-09)
   - Verification guide for `/v2/activities/feedback` endpoint
   - Status: Feature implemented and deployed
   - Archive reason: Verification process complete

### Implementation Fixes (Applied)

3. **SCHEMA_FIX_GENERIC_RESOLVERS.md** (2026-04-09)
   - Fix for activity table schema to support generic resolvers
   - Status: Migration applied to production
   - Archive reason: Fix has been deployed, schema is updated

### Implementation Summaries (Completed)

4. **FEEDBACK_IMPLEMENTATION_SUMMARY.md** (2026-04-09)
   - Summary of feedback endpoint implementation
   - Status: Feature complete
   - Archive reason: Implementation complete, consolidated into CLAUDE.md

5. **FEEDBACK_QUICK_REFERENCE.md** (2026-04-09)
   - Quick reference for feedback API
   - Status: Feature documented
   - Archive reason: Duplicate information, consolidated into main docs

### Point-in-Time Analysis

6. **GAP_ANALYSIS_AND_PLAN.md** (2026-04-06)
   - Gap analysis of activity system architecture vs implementation
   - Status: Historical snapshot
   - Archive reason: Analysis reflects specific point in time, may no longer represent current state

## Canonical Documentation (Still Active)

The following documents remain as canonical references:

- **CLAUDE.md** - Vessel-specific development guidelines
- **DISCOVERY_INTEGRATION.md** - Discovery vessel integration
- **SHAPE_REGISTRY.md** - Shape registry implementation
- **CI_CD_INTEGRATION.md** - CI/CD webhook integration
- **README.md** - Repository overview and setup
- **docs/SURREALDB_TYPES.md** - SurrealDB type handling guide
- **sql/SCHEMA_CONVENTIONS.md** - Schema conventions

## Archive Policy

Documents are archived when:
- Verification is complete and stable
- Implementation is deployed and documented elsewhere
- Point-in-time analysis is no longer reflective of current state
- Documentation is consolidated into canonical sources

Archived documents are preserved for historical reference and can inform future similar work.
