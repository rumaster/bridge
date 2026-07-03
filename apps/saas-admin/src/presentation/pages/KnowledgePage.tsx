import { FormEvent, useEffect, useMemo, useState } from "react";
import { BookOpen, FileUp, RefreshCw, Save, Trash2 } from "lucide-react";

import type {
  KnowledgeDocument,
  KnowledgeDocumentStatus,
  ProblemDetails
} from "../../api/client/types";
import { useSaasAdminApi } from "../../state/admin";
import { hasAnyRole, useAuth } from "../../state/auth";
import { Badge, Button, Panel, TextInput } from "../../shared/ui-kit";

interface UploadFormState {
  title: string;
  source: string;
  file: File | null;
}

interface DocumentDraft {
  title: string;
  source: string;
}

type UploadFieldErrors = Partial<Record<keyof UploadFormState, string>>;

const emptyUploadForm: UploadFormState = {
  title: "",
  source: "",
  file: null
};

export default function KnowledgePage() {
  const { session } = useAuth();
  const api = useSaasAdminApi();
  const canEdit = hasAnyRole(session, ["administrator"]);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DocumentDraft>>({});
  const [uploadForm, setUploadForm] = useState<UploadFormState>(emptyUploadForm);
  const [fieldErrors, setFieldErrors] = useState<UploadFieldErrors>({});
  const [alert, setAlert] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingDocumentId, setSavingDocumentId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

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

  const summary = useMemo(() => {
    const indexed = documents.filter((document) => document.status === "indexed").length;
    const indexing = documents.filter((document) => document.status === "indexing").length;
    const failed = documents.filter((document) => document.status === "failed").length;
    return { failed, indexed, indexing, total: documents.length };
  }, [documents]);

  function updateUploadField<TKey extends keyof UploadFormState>(
    field: TKey,
    value: UploadFormState[TKey]
  ) {
    setUploadForm((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
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

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!session) {
      return;
    }

    const errors = validateUploadForm(uploadForm);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setAlert("Проверьте параметры документа.");
      return;
    }

    setUploading(true);
    setAlert(null);
    setSuccess(null);
    setFieldErrors({});

    try {
      const created = await api.knowledge.createDocument({
        organization_id: session.organization.id,
        title: uploadForm.title.trim(),
        ...(uploadForm.source.trim() ? { source: uploadForm.source.trim() } : {}),
        ...(uploadForm.file
          ? {
              file_name: uploadForm.file.name,
              content_type: uploadForm.file.type || "application/octet-stream",
              size_bytes: uploadForm.file.size
            }
          : {})
      });

      setDocuments((current) => [created, ...current]);
      setDrafts((current) => ({
        ...current,
        [created.id]: toDraft(created)
      }));
      setUploadForm(emptyUploadForm);
      setSuccess("Документ поставлен на индексацию");
    } catch (error) {
      const problem = getProblemDetails(error);
      setFieldErrors(toUploadFieldErrors(problem));
      setAlert(problem?.detail ?? getProblemMessage(error, "Не удалось загрузить документ."));
    } finally {
      setUploading(false);
    }
  }

  async function handleSaveDocument(document: KnowledgeDocument) {
    const draft = drafts[document.id];
    if (!draft) {
      return;
    }

    setSavingDocumentId(document.id);
    setAlert(null);
    setSuccess(null);

    try {
      const updated = await api.knowledge.updateDocument(document.id, {
        title: draft.title,
        source: draft.source
      });
      setDocuments((current) => replaceDocument(current, updated));
      setDrafts((current) => ({
        ...current,
        [updated.id]: toDraft(updated)
      }));
      setSuccess("Документ обновлен");
    } catch (error) {
      setAlert(getProblemMessage(error, "Не удалось обновить документ."));
    } finally {
      setSavingDocumentId(null);
    }
  }

  async function handleReindexDocument(document: KnowledgeDocument) {
    setSavingDocumentId(document.id);
    setAlert(null);
    setSuccess(null);

    try {
      const result = await api.knowledge.reindexDocument(document.id);
      setDocuments((current) =>
        current.map((item) =>
          item.id === document.id
            ? {
                ...item,
                status: result.status,
                indexed_at: null,
                updated_at: result.queued_at,
                error_message: undefined
              }
            : item
        )
      );
      setSuccess("Переиндексация поставлена в очередь");
    } catch (error) {
      setAlert(getProblemMessage(error, "Не удалось поставить переиндексацию."));
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
      setSuccess("Документ удален");
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
        <p>Документы управляются через C3.kb, статус индексации отражает очередь reindex.</p>
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
              <strong>{summary.total}</strong>
            </Panel>
            <Panel className="summary-panel">
              <span className="metric-label">Проиндексировано</span>
              <strong>{summary.indexed}</strong>
            </Panel>
            <Panel className="summary-panel">
              <span className="metric-label">Требуют внимания</span>
              <strong>{summary.failed}</strong>
            </Panel>
          </div>

          <Panel as="form" className="m2-form" onSubmit={(event) => void handleUpload(event)}>
            <div className="panel-heading-row">
              <div>
                <h2>Загрузка документа</h2>
                <p>Новый файл сразу получает статус индексации.</p>
              </div>
              <Button disabled={uploading} type="submit">
                <FileUp aria-hidden="true" size={16} />
                Загрузить документ
              </Button>
            </div>
            <div className="form-grid">
              <TextInput
                error={fieldErrors.title}
                id="knowledge-upload-title"
                label="Название документа"
                onChange={(event) => updateUploadField("title", event.currentTarget.value)}
                value={uploadForm.title}
              />
              <TextInput
                error={fieldErrors.source}
                id="knowledge-upload-source"
                label="Источник"
                onChange={(event) => updateUploadField("source", event.currentTarget.value)}
                placeholder="manual://returns"
                value={uploadForm.source}
              />
              <label className="text-input file-input" htmlFor="knowledge-file">
                <span>Файл документа</span>
                <input
                  id="knowledge-file"
                  onChange={(event) => updateUploadField("file", event.currentTarget.files?.[0] ?? null)}
                  type="file"
                />
                {uploadForm.file ? <span className="muted">{uploadForm.file.name}</span> : null}
              </label>
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
                onReindex={() => void handleReindexDocument(document)}
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
  onReindex: () => void;
  onSave: () => void;
  saving: boolean;
}

function KnowledgeDocumentCard({
  document,
  draft,
  onDelete,
  onDraftChange,
  onReindex,
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
            <span className="muted">{document.file_name ?? "без файла"}</span>
          </div>
        </div>
        <Badge tone={getDocumentStatusTone(document.status)}>
          {getDocumentStatusLabel(document.status)}
        </Badge>
      </div>

      <div className="form-grid compact-form-grid">
        <TextInput
          id={`knowledge-title-${document.id}`}
          label="Название в KB"
          onChange={(event) => onDraftChange("title", event.currentTarget.value)}
          value={draft.title}
        />
        <TextInput
          id={`knowledge-source-${document.id}`}
          label="Источник в KB"
          onChange={(event) => onDraftChange("source", event.currentTarget.value)}
          value={draft.source}
        />
      </div>

      <dl className="metadata-list">
        <div>
          <dt>Индексирован</dt>
          <dd>{document.indexed_at ?? "Нет"}</dd>
        </div>
        <div>
          <dt>Размер</dt>
          <dd>{document.size_bytes ? `${document.size_bytes} bytes` : "Нет данных"}</dd>
        </div>
      </dl>

      <IndexingIndicator document={document} />

      {document.error_message ? (
        <div className="form-alert" role="alert">
          {document.error_message}
        </div>
      ) : null}

      <div className="form-actions">
        <Button disabled={saving} onClick={onSave} type="button" variant="secondary">
          <Save aria-hidden="true" size={16} />
          Сохранить документ
        </Button>
        <Button disabled={saving} onClick={onReindex} type="button" variant="secondary">
          <RefreshCw aria-hidden="true" size={16} />
          Переиндексировать
        </Button>
        <Button disabled={saving} onClick={onDelete} type="button" variant="ghost">
          <Trash2 aria-hidden="true" size={16} />
          Удалить документ
        </Button>
      </div>
    </Panel>
  );
}

function IndexingIndicator({ document }: { document: KnowledgeDocument }) {
  return (
    <div className={`indexing-indicator ${document.status}`} aria-label={`Индексация ${document.title}`}>
      <span>{getDocumentStatusLabel(document.status)}</span>
      <div>
        <span style={{ width: `${getDocumentStatusProgress(document.status)}%` }} />
      </div>
    </div>
  );
}

function validateUploadForm(form: UploadFormState): UploadFieldErrors {
  const errors: UploadFieldErrors = {};

  if (!form.title.trim()) {
    errors.title = "Название документа обязательно.";
  }

  return errors;
}

function toDrafts(documents: KnowledgeDocument[]) {
  return Object.fromEntries(documents.map((document) => [document.id, toDraft(document)]));
}

function toDraft(document: KnowledgeDocument): DocumentDraft {
  return {
    title: document.title,
    source: document.source ?? ""
  };
}

function replaceDocument(documents: KnowledgeDocument[], nextDocument: KnowledgeDocument) {
  return documents.map((document) => (document.id === nextDocument.id ? nextDocument : document));
}

function getDocumentStatusLabel(status: KnowledgeDocumentStatus) {
  switch (status) {
    case "indexed":
      return "Проиндексирован";
    case "indexing":
      return "Индексация";
    case "failed":
      return "Ошибка индекса";
  }
}

function getDocumentStatusTone(status: KnowledgeDocumentStatus) {
  return status === "indexed" ? "success" : "warning";
}

function getDocumentStatusProgress(status: KnowledgeDocumentStatus) {
  switch (status) {
    case "indexed":
      return 100;
    case "indexing":
      return 55;
    case "failed":
      return 20;
  }
}

function toUploadFieldErrors(problem: ProblemDetails | null): UploadFieldErrors {
  const errors: UploadFieldErrors = {};

  for (const error of problem?.errors ?? []) {
    if (error.field === "title") {
      errors.title = error.message;
    }

    if (error.field === "source") {
      errors.source = error.message;
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
