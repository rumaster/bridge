import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useBlocker } from "react-router-dom";
import type { BlockerFunction } from "react-router-dom";
import { BookOpen, Plus, Save, Trash2 } from "lucide-react";

import type {
  KnowledgeDocument,
  ProblemDetails
} from "../../api/client/types";
import { useSaasAdminApi } from "../../state/admin";
import { hasAnyRole, useAuth } from "../../state/auth";
import { Badge, Button, Panel, TextAreaInput, TextInput } from "../../shared/ui-kit";

interface DocumentDraft {
  title: string;
  content: string;
  /** Ключевые фразы, по одной на строку (в API уходит массивом). */
  sources: string;
  /** Теги, по одному на строку (в API уходит массивом). */
  tags: string;
}

type DraftFieldErrors = Partial<Record<keyof DocumentDraft, string>>;

/**
 * Что редактор собирается сделать после подтверждения потери изменений:
 * создать новый документ или открыть другой из списка.
 */
type PendingSelection = { kind: "new" } | { kind: "document"; documentId: string };

const emptyDraft: DocumentDraft = {
  title: "",
  content: "",
  sources: "",
  tags: ""
};

/** Текстовое поле «по одной фразе на строку» ⇄ массив фраз API. */
function splitLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export default function KnowledgePage() {
  const { session } = useAuth();
  const api = useSaasAdminApi();
  const canEdit = hasAnyRole(session, ["administrator"]);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  /** null — редактор в режиме создания нового документа. */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DocumentDraft>(emptyDraft);
  /** Сохранённое состояние выбранного документа: с ним сравниваем черновик. */
  const [baseline, setBaseline] = useState<DocumentDraft>(emptyDraft);
  const [errors, setErrors] = useState<DraftFieldErrors>({});
  const [pendingSelection, setPendingSelection] = useState<PendingSelection | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;

    if (!session || !canEdit) {
      setLoading(false);
      return () => {
        active = false;
      };
    }

    setLoading(true);
    api.knowledge
      .listDocuments()
      .then((nextDocuments) => {
        if (active) {
          setDocuments(nextDocuments);
          setAlert(null);
        }
      })
      .catch((error) => {
        if (active) {
          setAlert(getProblemMessage(error, "Не удалось загрузить Knowledge Base."));
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [api, canEdit, session]);

  const selectedDocument = useMemo(
    () => documents.find((document) => document.id === selectedId) ?? null,
    [documents, selectedId]
  );
  const isDirty = useMemo(() => !isSameDraft(draft, baseline), [baseline, draft]);

  // Уход со страницы: блокируем переход роутера, пока есть несохранённые правки.
  const blocker = useBlocker(
    useCallback<BlockerFunction>(
      ({ currentLocation, nextLocation }) =>
        isDirty && currentLocation.pathname !== nextLocation.pathname,
      [isDirty]
    )
  );

  // Закрытие вкладки/перезагрузка — нативное предупреждение браузера.
  useEffect(() => {
    if (!isDirty) {
      return;
    }

    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);

  function openDraft(document: KnowledgeDocument | null) {
    const nextDraft = document ? toDraft(document) : emptyDraft;
    setSelectedId(document?.id ?? null);
    setDraft(nextDraft);
    setBaseline(nextDraft);
    setErrors({});
    setAlert(null);
    setSuccess(null);
  }

  /** Переключение редактора: при несохранённых правках сначала спрашиваем. */
  function requestSelection(selection: PendingSelection) {
    if (selection.kind === "document" && selection.documentId === selectedId) {
      return;
    }

    if (selection.kind === "new" && selectedId === null && !isDirty) {
      return;
    }

    if (isDirty) {
      setPendingSelection(selection);
      return;
    }

    applySelection(selection);
  }

  function applySelection(selection: PendingSelection) {
    if (selection.kind === "new") {
      openDraft(null);
      return;
    }

    openDraft(documents.find((document) => document.id === selection.documentId) ?? null);
  }

  function updateField(field: keyof DocumentDraft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setSuccess(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!session) {
      return;
    }

    const validationErrors = validateDraft(draft);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      setAlert("Заполните название и контент документа.");
      return;
    }

    setSaving(true);
    setAlert(null);
    setSuccess(null);
    setErrors({});

    try {
      if (selectedDocument) {
        const updated = await api.knowledge.updateDocument(selectedDocument.id, {
          title: draft.title.trim(),
          content: draft.content.trim(),
          embedding_sources: splitLines(draft.sources),
          tags: splitLines(draft.tags)
        });

        setDocuments((current) => replaceDocument(current, updated));
        setBaseline(toDraft(updated));
        setDraft(toDraft(updated));
        setSuccess("Документ обновлён и переиндексирован");
      } else {
        const created = await api.knowledge.createDocument({
          organization_id: session.organization.id,
          title: draft.title.trim(),
          content: draft.content.trim(),
          embedding_sources: splitLines(draft.sources),
          tags: splitLines(draft.tags)
        });

        setDocuments((current) => [created, ...current]);
        setSelectedId(created.id);
        setBaseline(toDraft(created));
        setDraft(toDraft(created));
        setSuccess("Документ добавлен и проиндексирован");
      }
    } catch (error) {
      const problem = getProblemDetails(error);
      setErrors(toDraftFieldErrors(problem));
      setAlert(
        problem?.detail ??
          getProblemMessage(
            error,
            selectedDocument ? "Не удалось обновить документ." : "Не удалось сохранить документ."
          )
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!selectedDocument) {
      return;
    }

    setSaving(true);
    setAlert(null);
    setSuccess(null);

    try {
      await api.knowledge.deleteDocument(selectedDocument.id);
      setDocuments((current) => current.filter((item) => item.id !== selectedDocument.id));
      openDraft(null);
      setSuccess("Документ удалён");
    } catch (error) {
      setAlert(getProblemMessage(error, "Не удалось удалить документ."));
    } finally {
      setSaving(false);
    }
  }

  function handleDiscard() {
    if (pendingSelection) {
      const selection = pendingSelection;
      setPendingSelection(null);
      applySelection(selection);
      return;
    }

    blocker.proceed?.();
  }

  function handleStay() {
    setPendingSelection(null);
    blocker.reset?.();
  }

  const guardOpen = pendingSelection !== null || blocker.state === "blocked";

  return (
    <section className="page-section">
      <div className="page-heading">
        <Badge tone="neutral">Знания</Badge>
        <h1>Knowledge Base</h1>
        <p>
          Текстовые инструкции для AI Assistant. Контент подставляется в промпт, а находится
          документ по ключевым фразам: эмбеддинг вычисляется при сохранении для каждой фразы
          отдельно. Документ без ключевых фраз сохранится, но в поиск не попадёт.
        </p>
      </div>

      {!canEdit ? (
        <Panel className="empty-state">
          <Badge tone="warning">Роль</Badge>
          <h2>Раздел скрыт для текущей роли</h2>
        </Panel>
      ) : null}

      {alert ? (
        <div className="form-alert" role="alert">
          {alert}
        </div>
      ) : null}

      {success ? <div className="form-success">{success}</div> : null}

      {canEdit ? (
        <div className="knowledge-layout">
          <Panel aria-label="Документы Knowledge Base" as="aside" className="knowledge-sidebar">
            <div className="knowledge-sidebar-head">
              <h2>Документы</h2>
              <Button
                onClick={() => requestSelection({ kind: "new" })}
                type="button"
                variant="secondary"
              >
                <Plus aria-hidden="true" size={16} />
                Новый документ
              </Button>
            </div>

            {loading ? (
              <div className="route-loader">Загрузка Knowledge Base...</div>
            ) : (
              <ul className="knowledge-doc-list">
                {documents.map((document) => (
                  <li key={document.id}>
                    <button
                      aria-current={document.id === selectedId ? "true" : undefined}
                      className={`knowledge-doc-item ${document.id === selectedId ? "active" : ""}`}
                      onClick={() =>
                        requestSelection({ kind: "document", documentId: document.id })
                      }
                      type="button"
                    >
                      <BookOpen aria-hidden="true" size={16} />
                      <span className="knowledge-doc-item-body">
                        <span className="knowledge-doc-item-title">{document.title}</span>
                        <span className="muted">
                          {document.embedding_sources.length > 0
                            ? `Ключевых фраз: ${document.embedding_sources.length}`
                            : "Без ключевых фраз — не находится"}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
                {documents.length === 0 ? (
                  <li className="muted knowledge-doc-empty">Документов пока нет</li>
                ) : null}
              </ul>
            )}
          </Panel>

          <Panel
            aria-label="Редактор документа"
            as="form"
            className="m2-form knowledge-editor"
            onSubmit={(event) => void handleSubmit(event)}
          >
            <div className="panel-heading-row">
              <div>
                <h2>{selectedDocument ? "Редактирование документа" : "Новый документ"}</h2>
                <p>
                  {selectedDocument
                    ? `Обновлён: ${formatUpdatedAt(selectedDocument.updated_at)}`
                    : "Название описывает суть, контент встраивается в промпт ассистента."}
                </p>
              </div>
              {isDirty ? <Badge tone="warning">Есть изменения</Badge> : null}
            </div>

            <div className="form-grid">
              <TextInput
                error={errors.title}
                id="knowledge-title"
                label="Название документа"
                onChange={(event) => updateField("title", event.currentTarget.value)}
                placeholder="Например: Политика возвратов"
                value={draft.title}
              />
              <TextAreaInput
                error={errors.content}
                id="knowledge-content"
                label="Контент (инструкция для ассистента)"
                onChange={(event) => updateField("content", event.currentTarget.value)}
                placeholder="Текст, который будет добавлен в промпт при релевантном запросе."
                rows={10}
                value={draft.content}
              />
              <TextAreaInput
                error={errors.sources}
                id="knowledge-sources"
                label="Ключевые фразы — по одной на строку"
                onChange={(event) => updateField("sources", event.currentTarget.value)}
                placeholder={"возврат товара\nкак вернуть покупку\nденьги за возврат"}
                rows={5}
                value={draft.sources}
              />
              <TextAreaInput
                error={errors.tags}
                id="knowledge-tags"
                label="Теги — по одному на строку (необязательно)"
                onChange={(event) => updateField("tags", event.currentTarget.value)}
                placeholder={"возвраты\nпродажи"}
                rows={3}
                value={draft.tags}
              />
            </div>

            <div className="form-actions">
              <Button disabled={saving} type="submit">
                {selectedDocument ? (
                  <Save aria-hidden="true" size={16} />
                ) : (
                  <Plus aria-hidden="true" size={16} />
                )}
                {selectedDocument ? "Обновить документ" : "Добавить документ"}
              </Button>
              {selectedDocument ? (
                <Button
                  disabled={saving}
                  onClick={() => void handleDelete()}
                  type="button"
                  variant="ghost"
                >
                  <Trash2 aria-hidden="true" size={16} />
                  Удалить
                </Button>
              ) : null}
            </div>
          </Panel>
        </div>
      ) : null}

      {guardOpen ? (
        <div className="workflow-modal-overlay">
          <div
            aria-labelledby="knowledge-guard-title"
            aria-modal="true"
            className="workflow-modal knowledge-guard"
            role="dialog"
          >
            <div className="workflow-modal-head">
              <h2 id="knowledge-guard-title">Несохранённые изменения</h2>
            </div>
            <div className="workflow-modal-body">
              <p>
                В редакторе есть изменения, которые не сохранены. Если продолжить, они будут
                потеряны.
              </p>
              <div className="form-actions">
                <Button onClick={handleStay} type="button">
                  Остаться в редакторе
                </Button>
                <Button onClick={handleDiscard} type="button" variant="ghost">
                  Потерять изменения и перейти
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function validateDraft(draft: DocumentDraft): DraftFieldErrors {
  const errors: DraftFieldErrors = {};

  if (!draft.title.trim()) {
    errors.title = "Название документа обязательно.";
  }

  if (!draft.content.trim()) {
    errors.content = "Контент документа обязателен.";
  }

  return errors;
}

function formatUpdatedAt(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("ru-RU");
}

function isSameDraft(left: DocumentDraft, right: DocumentDraft) {
  return (
    left.title === right.title &&
    left.content === right.content &&
    left.sources === right.sources &&
    left.tags === right.tags
  );
}

function toDraft(document: KnowledgeDocument): DocumentDraft {
  return {
    title: document.title,
    content: document.content,
    sources: (document.embedding_sources ?? []).join("\n"),
    tags: (document.tags ?? []).join("\n")
  };
}

function replaceDocument(documents: KnowledgeDocument[], nextDocument: KnowledgeDocument) {
  return documents.map((document) => (document.id === nextDocument.id ? nextDocument : document));
}

function toDraftFieldErrors(problem: ProblemDetails | null): DraftFieldErrors {
  const errors: DraftFieldErrors = {};

  for (const error of problem?.errors ?? []) {
    if (error.field === "title") {
      errors.title = error.message;
    }

    if (error.field === "content") {
      errors.content = error.message;
    }
  }

  return errors;
}

function getProblemDetails(error: unknown): ProblemDetails | null {
  const maybeError = error as { body?: ProblemDetails };
  return maybeError.body ?? null;
}

function getProblemMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}
