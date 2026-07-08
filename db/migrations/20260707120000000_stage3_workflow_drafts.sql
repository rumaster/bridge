-- up migration

ALTER TABLE workflows
  ADD COLUMN draft_schema jsonb,
  ADD COLUMN draft_updated_at timestamptz,
  ADD CONSTRAINT workflows_draft_schema_is_object
    CHECK (draft_schema IS NULL OR jsonb_typeof(draft_schema) = 'object'),
  ADD CONSTRAINT workflows_draft_timestamp_matches_schema
    CHECK (
      (draft_schema IS NULL AND draft_updated_at IS NULL)
      OR (draft_schema IS NOT NULL AND draft_updated_at IS NOT NULL)
    ),
  ADD CONSTRAINT workflows_draft_updated_after_created_check
    CHECK (draft_updated_at IS NULL OR draft_updated_at >= created_at);

-- down migration

ALTER TABLE workflows
  DROP CONSTRAINT IF EXISTS workflows_draft_updated_after_created_check,
  DROP CONSTRAINT IF EXISTS workflows_draft_timestamp_matches_schema,
  DROP CONSTRAINT IF EXISTS workflows_draft_schema_is_object,
  DROP COLUMN IF EXISTS draft_updated_at,
  DROP COLUMN IF EXISTS draft_schema;
