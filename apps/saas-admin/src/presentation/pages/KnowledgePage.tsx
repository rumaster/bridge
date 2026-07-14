import { FormEvent, useEffect, useMemo, useState } from "react";
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
}

type DraftFieldErrors = Partial<Record<keyof DocumentDraft, string>>;

const emptyDraft: DocumentDraft = {
  title: "",
  content: ""
};

export default function KnowledgePage() {
  const { session } = useAuth();
  const api = useSaasAdminApi();
  const canEdit = hasAnyRole(session, ["administrator"]);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DocumentDraft>>({});
  const [createForm, setCreateForm] = useState<DocumentDraft>(emptyDraft);
  const [createErrors, setCreateErrors] = useState<DraftFieldErrors>({});
  const [alert, setAlert] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingDocumentId, setSavingDocumentId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

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
          setDrafts(toDrafts(nextDocuments));
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

  const total = useMemo(() => documents.length, [documents]);

  function updateCreateField(field: keyof DocumentDraft, value: string) {
    setCreateForm((current) => ({ ...current, [field]: value }));
    setCreateErrors((current) => ({ ...current, [field]: undefined }));
    setSuccess(null);
  }

  function updateDraft(documentId: string, field: keyof DocumentDraft, value: string) {
    setDrafts((current) => ({
      ...current,
      [documentId]: {
        ...current[documentId],
        [field]: value
      }
    }));
    setSuccess(null);
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!session) {
      return;
    }

    const errors = validateDraft(createForm);
    if (Object.keys(errors).length > 0) {
      setCreateErrors(errors);
      setAlert("Заполните название и контент документа.");
      return;
    }

    setCreating(true);
    setAlert(null);
    setSuccess(null);
    setCreateErrors({});

    try {
      const created = await api.knowledge.createDocument({
        organization_id: session.organization.id,
        title: createForm.title.trim(),
        content: createForm.content.trim()
      });

      setDocuments((current) => [created, ...current]);
      setDrafts((current) => ({
        ...current,
        [created.id]: toDraft(created)
      }));
      setCreateForm(emptyDraft);
      setSuccess("Документ добавлен и проиндексирован");
    } catch (error) {
      const problem = getProblemDetails(error);
      setCreateErrors(toDraftFieldErrors(problem));
      setAlert(problem?.detail ?? getProblemMessage(error, "Не удалось сохранить документ."));
    } finally {
      setCreating(false);
    }
  }

  async function handleSaveDocument(document: KnowledgeDocument) {
    const draft = drafts[document.id];
    if (!draft) {
      return;
    }

    const errors = validateDraft(draft);
    if (Object.keys(errors).length > 0) {
      setAlert("Название и контент документа не могут быть пустыми.");
      return;
    }

    setSavingDocumentId(document.id);
    setAlert(null);
    setSuccess(null);

    try {
      const updated = await api.knowledge.updateDocument(document.id, {
        title: draft.title.trim(),
        content: draft.content.trim()
      });
      setDocuments((current) => replaceDocument(current, updated));
      setDrafts((current) => ({
        ...current,
        [updated.id]: toDraft(updated)
      }));
      setSuccess("Документ обновлён и переиндексирован");
    } catch (error) {
      setAlert(getProblemMessage(error, "Не удалось обновить документ."));
    } finally {
      setSavingDocumentId(null);
    }
  }

  async function handleDeleteDocument(document: KnowledgeDocument) {
    setSavingDocumentId(document.id);
    setAlert(null);
    setSuccess(null);

    try {
      await api.knowledge.deleteDocument(document.id);
      setDocuments((current) => current.filter((item) => item.id !== document.id));
      setDrafts((current) => {
        const { [document.id]: _deleted, ...rest } = current;
        return rest;
      });
      setSuccess("Документ удалён");
    } catch (error) {
      setAlert(getProblemMessage(error, "Не удалось удалить документ."));
    } finally {
      setSavingDocumentId(null);
    }
  }

  return (
    <section className="page-section">
      <div className="page-heading">
        <Badge tone="neutral">Знания</Badge>
        <h1>Knowledge Base</h1>
        <p>
          Текстовые инструкции для AI Assistant. Каждый документ подтягивается в промпт через
          семантический поиск (RAG); эмбеддинг вычисляется при сохранении.
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
        <>
          <div className="summary-grid m2-summary">
            <Panel className="summary-panel">
              <span className="metric-label">Документов</span>
              <strong>{total}</strong>
            </Panel>
          </div>

          <Panel
            aria-label="Новый документ"
            as="form"
            className="m2-form"
            onSubmit={(event) => void handleCreate(event)}
          >
            <div className="panel-heading-row">
              <div>
                <h2>Новый документ</h2>
                <p>Название описывает суть, контент встраивается в промпт ассистента.</p>
              </div>
              <Button disabled={creating} type="submit">
                <Plus aria-hidden="true" size={16} />
                Добавить документ
              </Button>
            </div>
            <div className="form-grid">
              <TextInput
                error={createErrors.title}
                id="knowledge-create-title"
                label="Название документа"
                onChange={(event) => updateCreateField("title", event.currentTarget.value)}
                placeholder="Например: Политика возвратов"
                value={createForm.title}
              />
              <TextAreaInput
                error={createErrors.content}
                id="knowledge-create-content"
                label="Контент (инструкция для ассистента)"
                onChange={(event) => updateCreateField("content", event.currentTarget.value)}
                placeholder="Текст, который будет добавлен в промпт при релевантном запросе."
                rows={6}
                value={createForm.content}
              />
            </div>
          </Panel>

          {loading ? <div className="route-loader">Загрузка Knowledge Base...</div> : null}

          <div className="knowledge-list">
            {documents.map((document) => (
              <KnowledgeDocumentCard
                document={document}
                draft={drafts[document.id] ?? toDraft(document)}
                key={document.id}
                onDelete={() => void handleDeleteDocument(document)}
                onDraftChange={(field, value) => updateDraft(document.id, field, value)}
                onSave={() => void handleSaveDocument(document)}
                saving={savingDocumentId === document.id}
              />
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

interface KnowledgeDocumentCardProps {
  document: KnowledgeDocument;
  draft: DocumentDraft;
  onDelete: () => void;
  onDraftChange: (field: keyof DocumentDraft, value: string) => void;
  onSave: () => void;
  saving: boolean;
}

function KnowledgeDocumentCard({
  document,
  draft,
  onDelete,
  onDraftChange,
  onSave,
  saving
}: KnowledgeDocumentCardProps) {
  return (
    <Panel aria-label={`${document.title} документ`} as="article" className="knowledge-card">
      <div className="panel-heading-row">
        <div className="channel-title">
          <BookOpen aria-hidden="true" size={22} />
          <div>
            <h2>{document.title}</h2>
            <span className="muted">Обновлён: {document.updated_at}</span>
          </div>
        </div>
      </div>

      <div className="form-grid">
        <TextInput
          id={`knowledge-title-${document.id}`}
          label="Название документа"
          onChange={(event) => onDraftChange("title", event.currentTarget.value)}
          value={draft.title}
        />
        <TextAreaInput
          id={`knowledge-content-${document.id}`}
          label="Контент"
          onChange={(event) => onDraftChange("content", event.currentTarget.value)}
          rows={6}
          value={draft.content}
        />
      </div>

      <div className="form-actions">
        <Button disabled={saving} onClick={onSave} type="button" variant="secondary">
          <Save aria-hidden="true" size={16} />
          Сохранить
        </Button>
        <Button disabled={saving} onClick={onDelete} type="button" variant="ghost">
          <Trash2 aria-hidden="true" size={16} />
          Удалить
        </Button>
      </div>
    </Panel>
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

function toDrafts(documents: KnowledgeDocument[]) {
  return Object.fromEntries(documents.map((document) => [document.id, toDraft(document)]));
}

function toDraft(document: KnowledgeDocument): DocumentDraft {
  return {
    title: document.title,
    content: document.content
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
