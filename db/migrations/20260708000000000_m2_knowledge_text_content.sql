-- up migration

-- Knowledge Base redesign: documents are now plain-text LLM instructions entered
-- through the admin UI (title + content), not uploaded files. The instruction text
-- lives on knowledge_documents.content; its embedding is computed on save and stored
-- as a single row in knowledge_chunks (see services/backend knowledge-base module).

ALTER TABLE knowledge_documents
  ADD COLUMN content text;

-- Backfill existing placeholder rows so the NOT NULL / not-blank constraints hold.
UPDATE knowledge_documents SET content = title WHERE content IS NULL;

ALTER TABLE knowledge_documents
  ALTER COLUMN content SET NOT NULL;

ALTER TABLE knowledge_documents
  ADD CONSTRAINT knowledge_documents_content_not_blank CHECK (btrim(content) <> '');

-- down migration

ALTER TABLE knowledge_documents
  DROP CONSTRAINT IF EXISTS knowledge_documents_content_not_blank;

ALTER TABLE knowledge_documents
  DROP COLUMN IF EXISTS content;
