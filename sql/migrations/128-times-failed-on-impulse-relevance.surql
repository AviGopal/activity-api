-- Migration 128: Add times_failed field to impulse_relevance_metrics
--
-- The writeImpulseRelevancePenalty path (posterior-update.ts) increments
-- times_failed on verifier_negative traces. The impulse_relevance_metrics
-- table is SCHEMAFULL; without this field the UPDATE is silently rejected
-- by SurrealDB with a "Found field 'times_failed', but no such field exists"
-- error (caught and swallowed in the try/catch). This migration adds the
-- missing field so spec 18.3.5 can be validated.

DEFINE FIELD IF NOT EXISTS times_failed ON TABLE impulse_relevance_metrics TYPE int DEFAULT 0;
