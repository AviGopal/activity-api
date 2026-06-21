-- 145-aet-signature-fields.surql
--
-- Define the v1 state-space `signature` + `signature_version` fields on
-- activity_execution_traces.
--
-- WHY (2026-06-21): activity_execution_traces is SCHEMAFULL, and `signature`
-- was never DEFINEd — so the signature-landing UPDATE in
-- routes/execution-traces.ts (which writes the derived v1 state-space signature
-- onto the trace row after deriving it from input_impulse_shapes) was being
-- SILENTLY DROPPED. The cts conditional posteriors accumulate regardless (the
-- posterior writer receives v1Sig directly), but the trace ROW carried no
-- signature, so the decision-topology coordinate of each trace was not
-- observable/queryable. Defining the field lands the write. option<…> so legacy
-- rows (and traces without a derivable signature) stay valid as NONE; no rebuild.
DEFINE FIELD OVERWRITE signature ON activity_execution_traces TYPE option<string>;
DEFINE FIELD OVERWRITE signature_version ON activity_execution_traces TYPE option<int>;
