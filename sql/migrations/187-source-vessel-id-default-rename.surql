-- 187 — retire the product-era vessel name from the two source_vessel_id defaults.
--
-- source_vessel_id is a write-only provenance stamp: nothing filters, joins or
-- asserts on its value. That is exactly what makes it easy to get wrong — an
-- application-side rename looks complete while the DATABASE keeps minting the old
-- string, because two field definitions carry it as a fallback VALUE. Any insert
-- that omits the column lands the retired name, silently, forever.
--
-- Migrations 140 and 141 defined those fallbacks. This redefines both to the
-- vessel's real name. It rewrites no existing rows: historical provenance stays
-- as it was recorded, which is the honest reading of a provenance stamp.

DEFINE FIELD OVERWRITE source_vessel_id ON refusal_events
  TYPE string VALUE $value OR 'activity-api';

DEFINE FIELD OVERWRITE source_vessel_id ON promote_gate_evaluations
  TYPE string VALUE $value OR 'activity-api';
