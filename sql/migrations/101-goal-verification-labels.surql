-- Migration 101: goal_verification_labels
-- Stores human and automated ground-truth labels for goal verification outcomes.
-- Used to build an oracle corpus for future validator calibration.

DEFINE TABLE OVERWRITE goal_verification_labels SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $token.org_id
    FOR create WHERE org_id = $token.org_id
    FOR update NONE
    FOR delete NONE;

DEFINE FIELD OVERWRITE org_id         ON goal_verification_labels TYPE string;
DEFINE FIELD OVERWRITE goal           ON goal_verification_labels TYPE string;
DEFINE FIELD OVERWRITE execution_id   ON goal_verification_labels TYPE string;
DEFINE FIELD OVERWRITE activity_id    ON goal_verification_labels TYPE string;
DEFINE FIELD OVERWRITE verdict        ON goal_verification_labels TYPE string
  ASSERT $value IN ['achieved', 'not_achieved', 'partial'];
DEFINE FIELD OVERWRITE confidence     ON goal_verification_labels TYPE float;
DEFINE FIELD OVERWRITE notes          ON goal_verification_labels TYPE option<string>;
DEFINE FIELD OVERWRITE labeler        ON goal_verification_labels TYPE string
  ASSERT $value IN ['human', 'automated'];
DEFINE FIELD OVERWRITE created_at     ON goal_verification_labels TYPE datetime DEFAULT time::now();

DEFINE INDEX OVERWRITE idx_gvl_org_execution
  ON goal_verification_labels FIELDS org_id, execution_id;
DEFINE INDEX OVERWRITE idx_gvl_org_activity
  ON goal_verification_labels FIELDS org_id, activity_id;
