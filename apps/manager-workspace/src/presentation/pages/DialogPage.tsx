import { FormEvent, useEffect, useMemo, useState } from "react";
import { Send } from "lucide-react";
import { useParams } from "react-router-dom";

import type { ClientProfile, Conversation, Message } from "../../api/client/types";
import { useManagerWorkspaceApi } from "../../state/workspace";
import { Badge, Button, Panel } from "../../shared/ui-kit";

export default function DialogPage() {
  const { conversationId = "conv-1" } = useParams();
  const api = useManagerWorkspaceApi();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [client, setClient] = useState<ClientProfile | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let active = true;

    async function loadDialog() {
      const nextConversation = await api.conversations.get(conversationId);
      const [nextMessages, nextClient] = await Promise.all([
        api.conversations.listMessages(conversationId),
        api.clients.get(nextConversation.clientId)
      ]);

      if (active) {
        setConversation(nextConversation);
        setMessages(nextMessages);
        setClient(nextClient);
        setError(null);
      }
    }

    loadDialog().catch((nextError) => {
      if (active) {
        setError(nextError instanceof Error ? nextError.message : "Не удалось загрузить диалог");
      }
    });

    return () => {
      active = false;
    };
  }, [api, conversationId]);

  const channelLabel = useMemo(() => conversation?.channel.replace("_", " ") ?? "mock", [conversation]);

  async function handleSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const content = draft.trim();
    if (!conversation || !content) {
      return;
    }

    const idempotencyKey = createIdempotencyKey(conversation.id);
    const optimisticMessage: Message = {
      id: `optimistic-${idempotencyKey}`,
      conversationId: conversation.id,
      channel: conversation.channel,
      direction: "outbound",
      senderType: "manager",
      content,
      status: "routed",
      createdAt: new Date().toISOString()
    };

    setDraft("");
    setSending(true);
    setSendError(null);
    setMessages((current) => appendMessage(current, optimisticMessage));

    try {
      const createdMessage = await api.messages.create({
        conversationId: conversation.id,
        content,
        idempotencyKey
      });

      setMessages((current) => reconcileMessage(current, optimisticMessage.id, createdMessage));
      setConversation((current) =>
        current
          ? {
              ...current,
              lastMessageAt: createdMessage.createdAt,
              lastMessagePreview: createdMessage.content,
              unreadCount: 0
            }
          : current
      );
    } catch (nextError) {
      setSendError(nextError instanceof Error ? nextError.message : "Не удалось отправить ответ");
      setMessages((current) =>
        current.map((message) =>
          message.id === optimisticMessage.id
            ? {
                ...message,
                status: "failed"
              }
            : message
        )
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="page-section">
      <div className="page-heading">
        <Badge tone="neutral">C3.messages · C3.clients</Badge>
        <h1>Диалог</h1>
        <p>{client ? client.displayName : "Загрузка клиента"} · {channelLabel}</p>
      </div>

      {error ? <p className="error-text">{error}</p> : null}

      <div className="dialog-layout">
        <Panel className="message-thread">
          {messages.map((message) => (
            <article className={`message-bubble ${message.direction}`} key={message.id}>
              <span>{message.content}</span>
              {message.attachments?.length ? (
                <div className="attachment-list">
                  {message.attachments.map((attachment) => (
                    <a className="attachment-link" href={attachment.url} key={attachment.id} rel="noreferrer" target="_blank">
                      <span>{attachment.name}</span>
                      <small>{formatBytes(attachment.sizeBytes)}</small>
                    </a>
                  ))}
                </div>
              ) : null}
              <small>{message.status}</small>
            </article>
          ))}

          <form className="reply-form" onSubmit={handleSend}>
            <label className="text-input reply-input" htmlFor="manager-reply">
              <span>Ответ менеджера</span>
              <textarea
                id="manager-reply"
                onChange={(event) => setDraft(event.target.value)}
                rows={3}
                value={draft}
              />
            </label>
            <div className="reply-actions">
              {sendError ? <p className="error-text">{sendError}</p> : null}
              <Button disabled={sending || draft.trim() === "" || !conversation} type="submit">
                <Send aria-hidden="true" size={16} />
                Отправить
              </Button>
            </div>
          </form>
        </Panel>

        <Panel className="client-card">
          <h2>Карточка клиента</h2>
          <p>{client?.displayName ?? "Загрузка"}</p>
          <div className="tag-list">
            {client?.tags.map((tag) => (
              <Badge key={tag} tone="neutral">
                {tag}
              </Badge>
            ))}
          </div>
          <div className="client-card-list">
            {client?.endpoints.map((endpoint) => (
              <div key={endpoint.id}>
                <strong>{endpoint.displayName}</strong>
                <span>{endpoint.externalId}</span>
              </div>
            ))}
          </div>
          <div className="client-card-list">
            {client?.notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
        </Panel>
      </div>
    </section>
  );
}

function appendMessage(messages: Message[], nextMessage: Message) {
  return [...messages, nextMessage].sort(compareMessagesByCreatedAt);
}

function reconcileMessage(messages: Message[], optimisticMessageId: string, createdMessage: Message) {
  return appendMessage(
    messages.filter((message) => message.id !== optimisticMessageId && message.id !== createdMessage.id),
    createdMessage
  );
}

function compareMessagesByCreatedAt(left: Message, right: Message) {
  return left.createdAt.localeCompare(right.createdAt);
}

function createIdempotencyKey(conversationId: string) {
  const randomPart = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${conversationId}-${randomPart}`;
}

function formatBytes(sizeBytes: number) {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  return `${Math.round(sizeBytes / 1024)} KB`;
}
