DEFINE TABLE IF NOT EXISTS context_thompson_scores SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $token.org_id
    FOR create, update WHERE $token.org_id IS NOT NONE
    FOR delete NONE;

DEFINE FIELD IF NOT EXISTS template_id ON context_thompson_scores TYPE string;
DEFINE FIELD IF NOT EXISTS org_id ON context_thompson_scores TYPE string;
DEFINE FIELD IF NOT EXISTS context_bucket ON context_thompson_scores TYPE string;
DEFINE FIELD IF NOT EXISTS alpha ON context_thompson_scores TYPE float DEFAULT 1.0;
DEFINE FIELD IF NOT EXISTS beta ON context_thompson_scores TYPE float DEFAULT 1.0;
DEFINE FIELD IF NOT EXISTS n_observations ON context_thompson_scores TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS last_updated_at ON context_thompson_scores TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS created_at ON context_thompson_scores TYPE datetime DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS idx_ctx_ts_bucket ON context_thompson_scores FIELDS org_id, context_bucket;
DEFINE INDEX IF NOT EXISTS idx_ctx_ts_template ON context_thompson_scores FIELDS org_id, template_id;
