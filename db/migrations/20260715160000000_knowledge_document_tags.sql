-- up migration

-- Теги документа базы знаний.
--
-- Редизайн KB от 2026-07-14 задал документу три поля: название, контент и список
-- ключевых (поисковых) фраз. Теги — четвёртое, добавлены 2026-07-15 под узел
-- «Поиск в Knowledge Base» контракта Workflow 2.0: у узла есть вход `tags`, и до
-- этой миграции фильтровать по нему было не по чему.
--
-- Теги НЕ участвуют в эмбеддинге: вектор по-прежнему считается по каждой ключевой
-- фразе. Тег — это грубый предфильтр «в каком разделе знаний искать», который
-- сужает множество ДО векторного поиска; смешивать его с семантикой нельзя, иначе
-- расстояния перестанут значить то, что значат.
ALTER TABLE knowledge_documents
  ADD COLUMN tags text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN knowledge_documents.tags IS
  'Теги-предфильтр для поиска (узел «Поиск в Knowledge Base»). В эмбеддинге не участвуют.';

-- Пустой тег — дырка в фильтре: документ с тегом '' совпал бы с запросом, где тег
-- не задан толком. CHECK не принимает подзапрос, поэтому unnest здесь недоступен и
-- проверка идёт операторами над массивом: NULL и пустая строка запрещены.
-- Обрезка пробельных тегов остаётся за приложением (normalizeSources) — как и у
-- embedding_sources, у которого ограничения нет вовсе.
ALTER TABLE knowledge_documents
  ADD CONSTRAINT knowledge_documents_tags_not_blank
  CHECK (array_position(tags, NULL) IS NULL AND array_position(tags, '') IS NULL);

-- GIN — индекс для оператора пересечения массивов (&&), которым фильтрует поиск.
CREATE INDEX knowledge_documents_tags_idx
  ON knowledge_documents USING gin (tags);

-- down migration

DROP INDEX IF EXISTS knowledge_documents_tags_idx;
ALTER TABLE knowledge_documents
  DROP CONSTRAINT IF EXISTS knowledge_documents_tags_not_blank;
ALTER TABLE knowledge_documents
  DROP COLUMN IF EXISTS tags;
