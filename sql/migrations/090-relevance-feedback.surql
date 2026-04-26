DEFINE TABLE IF NOT EXISTS relevance_feedback SCHEMALESS
  PERMISSIONS
    FOR select WHERE org_id = $token.org_id
    FOR create WHERE $token.org_id IS NOT NONE
    FOR update, delete NONE;
