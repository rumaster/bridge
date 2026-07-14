-- up migration

-- Knowledge Base: ключевые (поисковые) фразы документа. Эмбеддинги считаются НЕ
-- по контенту, а по каждой фразе из этого списка (образец — «Экспертиза» в
-- rumaster/fbp-engine): фраза задаёт, на какие запросы документ должен
-- находиться, а contents подставляется в промпт. Одна фраза → одна строка в
-- knowledge_chunks (embedding фразы, content документа, metadata.source = фраза).

ALTER TABLE knowledge_documents
  ADD COLUMN embedding_sources text[] NOT NULL DEFAULT '{}'::text[];

-- down migration

ALTER TABLE knowledge_documents
  DROP COLUMN IF EXISTS embedding_sources;
