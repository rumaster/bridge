import {
  FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { Send, Sparkles } from "lucide-react";
import { useParams } from "react-router-dom";

import type {
  AssistantSuggestResponse,
  ClientProfile,
  Conversation,
  C7Event,
  Message
} from "../../api/client/types";
import type { RealtimeConnectionStatus } from "../../api/client/realtime";
import { useAuth } from "../../state/auth";
import {
  advanceC7Sequence,
  applyC7EventToClients,
  applyC7EventToConversations,
  applyC7EventToMessages,
  applyC7EventToTypingClientIds,
  isC7SequenceGap,
  markC7EventSeen,
  mergeMessagesById
} from "../../state/realtime-merge";
import { useC7RealtimeClient, useManagerWorkspaceApi } from "../../state/workspace";
import {
  MANAGER_WORKSPACE_NFR_BUDGET_MS,
  recordClientNfrMeasurement,
  startClientNfrMeasurement
} from "../../shared/nfr";
import { Badge, Button, Panel } from "../../shared/ui-kit";

const MESSAGE_WINDOWING_THRESHOLD = 80;
const MESSAGE_ROW_ESTIMATE_PX = 88;
const MESSAGE_WINDOW_OVERSCAN = 8;
const MESSAGE_VIEWPORT_FALLBACK_HEIGHT_PX = 520;

export default function DialogPage() {
  const { conversationId = "conv-1" } = useParams();
  const api = useManagerWorkspaceApi();
  const realtime = useC7RealtimeClient();
  const { session } = useAuth();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [client, setClient] = useState<ClientProfile | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<RealtimeConnectionStatus>("offline");
  const [typingClientIds, setTypingClientIds] = useState<string[]>([]);
  const [assistantQuery, setAssistantQuery] = useState("");
  const [assistantResponse, setAssistantResponse] = useState<AssistantSuggestResponse | null>(null);
  const [assistantError, setAssistantError] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [dialogReady, setDialogReady] = useState(false);
  const lastSequenceNumberRef = useRef<number | null>(null);
  const seenEventIdsRef = useRef(new Set<string>());
  const seenMessageIdsRef = useRef(new Set<string>());

  const loadDialog = useCallback(async () => {
    const startedAt = startClientNfrMeasurement();

    try {
      const nextConversation = await api.conversations.get(conversationId);
      const [nextMessages, nextClient] = await Promise.all([
        api.conversations.listMessages(conversationId),
        api.clients.get(nextConversation.clientId)
      ]);

      return {
        nextConversation,
        nextMessages,
        nextClient
      };
    } finally {
      recordClientNfrMeasurement(
        "message_history",
        MANAGER_WORKSPACE_NFR_BUDGET_MS.message_history,
        startedAt
      );
    }
  }, [api, conversationId]);

  const catchUpMessages = useCallback(async () => {
    const nextMessages = await api.conversations.listMessages(conversationId);
    for (const message of nextMessages) {
      seenMessageIdsRef.current.add(message.id);
    }
    setMessages((current) => mergeMessagesById(current, nextMessages));
  }, [api, conversationId]);

  useEffect(() => {
    let active = true;

    setDialogReady(false);
    loadDialog()
      .then(({ nextConversation, nextMessages, nextClient }) => {
        if (active) {
          setConversation(nextConversation);
          setMessages(nextMessages);
          setClient(nextClient);
          setTypingClientIds([]);
          seenMessageIdsRef.current = new Set(nextMessages.map((message) => message.id));
          setError(null);
          setDialogReady(true);
        }
      })
      .catch((nextError) => {
        if (active) {
          setError(nextError instanceof Error ? nextError.message : "Не удалось загрузить диалог");
        }
      });

    return () => {
      active = false;
    };
  }, [loadDialog]);

  const channelLabel = useMemo(() => conversation?.channel.replace("_", " ") ?? "mock", [conversation]);
  const latestClientMessage = useMemo(
    () => [...messages].reverse().find((message) => message.senderType === "client")?.content ?? "",
    [messages]
  );

  useEffect(() => {
    if (!dialogReady) {
      return;
    }

    const connection = realtime.connect(
      (event) => {
        if (!markC7EventSeen(seenEventIdsRef.current, event)) {
          return;
        }

        if (isC7SequenceGap(lastSequenceNumberRef.current, event.sequence_number)) {
          void catchUpMessages().catch((nextError) => {
            setError(nextError instanceof Error ? nextError.message : "Не удалось догрузить realtime-историю");
          });
        }

        lastSequenceNumberRef.current = advanceC7Sequence(lastSequenceNumberRef.current, event);

        if (isConversationMessageEvent(event, conversationId)) {
          setMessages((current) => applyC7EventToMessages(current, event));
          setConversation((current) =>
            current
              ? applyC7EventToConversations([current], event, seenMessageIdsRef.current)[0] ?? current
              : current
          );
        }

        setClient((current) => (current ? applyC7EventToClients([current], event)[0] ?? current : current));
        setTypingClientIds((current) => applyC7EventToTypingClientIds(current, event, conversationId));
      },
      setConnectionStatus
    );

    return () => {
      connection.close();
    };
  }, [catchUpMessages, conversationId, dialogReady, realtime]);

  async function handleSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const content = draft.trim();
    if (!conversation || !content) {
      return;
    }

    const startedAt = startClientNfrMeasurement();
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
    setMessages((current) => mergeMessagesById(current, [optimisticMessage]));

    try {
      const createdMessage = await api.messages.create({
        conversationId: conversation.id,
        content,
        idempotencyKey
      });

      seenMessageIdsRef.current.add(createdMessage.id);
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
      recordClientNfrMeasurement(
        "send_message",
        MANAGER_WORKSPACE_NFR_BUDGET_MS.send_message,
        startedAt
      );
      setSending(false);
    }
  }

  async function handleAssistantSuggest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const query = assistantQuery.trim() || latestClientMessage || conversation?.lastMessagePreview;

    if (!conversation || !query) {
      return;
    }

    setSuggesting(true);
    setAssistantError(null);

    try {
      const response = await api.ai.suggest({
        contract: "C4.AssistantSuggestRequest",
        version: "1.0.0",
        request_id: createAssistantRequestId(conversation.id),
        organization_id: session?.organization.id ?? "org-1",
        conversation_id: conversation.id,
        requester_user_id: session?.user.id,
        query,
        context: {
          messages: messages.slice(-8).map((message) => ({
            message_id: message.id,
            sender_type: message.senderType,
            text: message.content,
            occurred_at: message.createdAt
          }))
        }
      });

      setAssistantResponse(response);
    } catch {
      setAssistantResponse(null);
      setAssistantError("AI недоступен. Переписка продолжает работать.");
    } finally {
      setSuggesting(false);
    }
  }

  return (
    <section className="page-section">
      <div className="page-heading">
        <Badge tone="neutral">C3.messages · C3.clients · C7 · C4</Badge>
        <h1>Диалог</h1>
        <p>{client ? client.displayName : "Загрузка клиента"} · {channelLabel}</p>
        <div className="realtime-meta">
          <Badge tone={connectionStatus === "connected" ? "success" : connectionStatus === "reconnecting" ? "warning" : "neutral"}>
            C7 {connectionStatus}
          </Badge>
          {typingClientIds.length > 0 ? <span>Клиент печатает</span> : null}
        </div>
      </div>

      {error ? <p className="error-text">{error}</p> : null}

      <div className="dialog-layout">
        <Panel className="message-thread">
          <VirtualizedMessageList messages={messages} />

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

        <div className="dialog-side">
          <Panel className="client-card">
            <h2>Карточка клиента</h2>
            <p>{client?.displayName ?? "Загрузка"}</p>
            {client?.status ? <Badge tone={client.status === "online" ? "success" : "neutral"}>{client.status}</Badge> : null}
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

          <Panel className="ai-panel">
            <div className="panel-title-row">
              <h2>AI-подсказки</h2>
              <Sparkles aria-hidden="true" size={18} />
            </div>
            <form className="ai-form" onSubmit={handleAssistantSuggest}>
              <label className="text-input ai-query" htmlFor="assistant-query">
                <span>Запрос к AI</span>
                <textarea
                  id="assistant-query"
                  onChange={(event) => setAssistantQuery(event.target.value)}
                  placeholder={latestClientMessage || "Кратко опишите нужную подсказку"}
                  rows={3}
                  value={assistantQuery}
                />
              </label>
              <Button disabled={suggesting || !conversation} type="submit" variant="secondary">
                <Sparkles aria-hidden="true" size={16} />
                Получить подсказку
              </Button>
            </form>

            {assistantError ? <p className="error-text">{assistantError}</p> : null}

            {assistantResponse ? (
              <div className="assistant-result">
                <p>{assistantResponse.suggestion.text}</p>
                <small>уверенность {Math.round(assistantResponse.suggestion.confidence * 100)}%</small>
                <div className="source-list">
                  {assistantResponse.sources.length > 0 ? (
                    assistantResponse.sources.map((source) => (
                      <div key={`${source.document_id ?? source.title}-${source.chunk_id ?? "source"}`}>
                        <strong>{source.title}</strong>
                        {source.excerpt ? <span>{source.excerpt}</span> : null}
                      </div>
                    ))
                  ) : (
                    <span>источники: {assistantResponse.source_status}</span>
                  )}
                </div>
              </div>
            ) : null}
          </Panel>
        </div>
      </div>
    </section>
  );
}

function VirtualizedMessageList({ messages }: { messages: Message[] }) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const shouldVirtualize = messages.length > MESSAGE_WINDOWING_THRESHOLD;
  const totalHeight = messages.length * MESSAGE_ROW_ESTIMATE_PX;
  const [scrollTop, setScrollTop] = useState(() =>
    shouldVirtualize ? Math.max(0, totalHeight - MESSAGE_VIEWPORT_FALLBACK_HEIGHT_PX) : 0
  );
  const [viewportHeight, setViewportHeight] = useState(MESSAGE_VIEWPORT_FALLBACK_HEIGHT_PX);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;

    if (!viewport) {
      return;
    }

    const nextViewportHeight = viewport.clientHeight || MESSAGE_VIEWPORT_FALLBACK_HEIGHT_PX;
    setViewportHeight(nextViewportHeight);

    if (!shouldVirtualize) {
      setScrollTop(0);
      return;
    }

    const nextScrollTop = Math.max(0, messages.length * MESSAGE_ROW_ESTIMATE_PX - nextViewportHeight);
    viewport.scrollTop = nextScrollTop;
    setScrollTop(nextScrollTop);
  }, [messages.length, shouldVirtualize]);

  const windowRange = useMemo(() => {
    if (!shouldVirtualize) {
      return {
        startIndex: 0,
        endIndex: messages.length
      };
    }

    const startIndex = Math.max(0, Math.floor(scrollTop / MESSAGE_ROW_ESTIMATE_PX) - MESSAGE_WINDOW_OVERSCAN);
    const visibleRows = Math.ceil(viewportHeight / MESSAGE_ROW_ESTIMATE_PX) + MESSAGE_WINDOW_OVERSCAN * 2;

    return {
      startIndex,
      endIndex: Math.min(messages.length, startIndex + visibleRows)
    };
  }, [messages.length, scrollTop, shouldVirtualize, viewportHeight]);

  const visibleMessages = messages.slice(windowRange.startIndex, windowRange.endIndex);
  const topSpacerHeight = shouldVirtualize ? windowRange.startIndex * MESSAGE_ROW_ESTIMATE_PX : 0;
  const bottomSpacerHeight = shouldVirtualize
    ? Math.max(0, (messages.length - windowRange.endIndex) * MESSAGE_ROW_ESTIMATE_PX)
    : 0;

  return (
    <div
      aria-label="История сообщений"
      aria-live="polite"
      className="message-list-viewport"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      ref={viewportRef}
      role="list"
      tabIndex={0}
    >
      {topSpacerHeight > 0 ? <div aria-hidden="true" className="message-window-spacer" style={{ height: topSpacerHeight }} /> : null}
      {visibleMessages.map((message, visibleIndex) => (
        <MessageBubble
          key={message.id}
          message={message}
          position={windowRange.startIndex + visibleIndex + 1}
          setSize={messages.length}
        />
      ))}
      {bottomSpacerHeight > 0 ? (
        <div aria-hidden="true" className="message-window-spacer" style={{ height: bottomSpacerHeight }} />
      ) : null}
    </div>
  );
}

function MessageBubble({
  message,
  position,
  setSize
}: {
  message: Message;
  position: number;
  setSize: number;
}) {
  return (
    <article
      aria-posinset={position}
      aria-setsize={setSize}
      className={`message-bubble ${message.direction}`}
      role="listitem"
    >
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
  );
}

function reconcileMessage(messages: Message[], optimisticMessageId: string, createdMessage: Message) {
  return mergeMessagesById(
    messages.filter((message) => message.id !== optimisticMessageId && message.id !== createdMessage.id),
    [createdMessage]
  );
}

function createIdempotencyKey(conversationId: string) {
  const randomPart = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${conversationId}-${randomPart}`;
}

function createAssistantRequestId(conversationId: string) {
  const randomPart = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${conversationId}:assistant:${randomPart}`;
}

function isConversationMessageEvent(event: C7Event, conversationId: string) {
  if (event.event === "message.created") {
    return event.payload.message.conversationId === conversationId;
  }

  if (event.event === "message.status_changed") {
    return event.payload.conversation_id === conversationId;
  }

  return false;
}

function formatBytes(sizeBytes: number) {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  return `${Math.round(sizeBytes / 1024)} KB`;
}
