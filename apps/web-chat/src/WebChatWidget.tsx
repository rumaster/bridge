import {
  FormEvent,
  UIEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createWebChatApiClient,
  DEFAULT_CONVERSATION_ID,
  DEFAULT_ORGANIZATION_ID,
} from "./platform/apiClient";
import {
  applyRealtimeEventToMessages,
  getLatestSequenceNumber,
  mergeWebChatMessages,
  updateWebChatMessageStatus,
} from "./platform/messageState";
import {
  createWebChatRealtimeClient,
  resolveRealtimeUrl,
} from "./platform/realtimeClient";
import {
  loadStoredVisitorSession,
  saveStoredVisitorSession,
} from "./platform/visitorSession";
import {
  createOutboundQueue,
  type OutboundQueue,
  type OutboundQueueItem,
} from "./platform/outboundQueue";
import { resolveEdgeConnection } from "./platform/edgeConnection";
import { IconButton, PrimaryButton, WidgetShell } from "./platform/uiKit";
import type { WebChatMessage, WebChatMountOptions, WebChatSession } from "./types";

export function WebChatWidget({
  apiBaseUrl,
  conversationId = DEFAULT_CONVERSATION_ID,
  edgeBaseUrl,
  historyPageSize = 20,
  organizationId = DEFAULT_ORGANIZATION_ID,
  outboundQueueStorage,
  realtimeEnabled = true,
  realtimeReconnectDelayMs,
  realtimeUrl,
  title = "Bridge Web Chat",
  webSocketFactory,
}: WebChatMountOptions) {
  const edge = useMemo(
    () => resolveEdgeConnection({ apiBaseUrl, realtimeUrl, edgeBaseUrl }),
    [apiBaseUrl, edgeBaseUrl, realtimeUrl],
  );
  const client = useMemo(
    () =>
      createWebChatApiClient({
        baseUrl: edge.apiBaseUrl,
        defaultHeaders: edge.headers,
      }),
    [edge],
  );
  const queueRef = useRef<OutboundQueue | null>(null);
  const [messages, setMessages] = useState<WebChatMessage[]>([]);
  const messagesRef = useRef<WebChatMessage[]>([]);
  const [messageText, setMessageText] = useState("");
  const [session, setSession] = useState<WebChatSession | null>(null);
  const sessionRef = useRef<WebChatSession | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [connectionState, setConnectionState] = useState<
    "connecting" | "online" | "reconnecting" | "offline"
  >("offline");
  const [typingNames, setTypingNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const replaceMessages = useCallback((nextMessages: WebChatMessage[]) => {
    messagesRef.current = nextMessages;
    setMessages(nextMessages);
  }, []);

  const mergeMessages = useCallback((nextMessages: WebChatMessage[]) => {
    setMessages((currentMessages) => {
      const mergedMessages = mergeWebChatMessages(currentMessages, nextMessages);
      messagesRef.current = mergedMessages;
      return mergedMessages;
    });
  }, []);

  useEffect(() => {
    let isActive = true;

    async function loadMessages() {
      try {
        const initializedSession = await client.createOrResumeSession({
          organizationId,
          visitorSessionId: loadStoredVisitorSession(),
          conversationId,
        });
        const loadedPage = await client.getMessages(
          initializedSession.conversationId,
          {
            limit: historyPageSize,
          },
        );
        if (isActive) {
          saveStoredVisitorSession(initializedSession.visitorSessionId);
          sessionRef.current = initializedSession;
          setSession(initializedSession);
          replaceMessages(loadedPage.messages);
          setHistoryCursor(loadedPage.nextCursor);
          setHasMoreHistory(loadedPage.hasMore);
          setError(null);
        }
      } catch (unknownError) {
        if (isActive) {
          setError(getErrorMessage(unknownError));
        }
      } finally {
        if (isActive) {
          setIsLoading(false);
        }
      }
    }

    void loadMessages();

    return () => {
      isActive = false;
    };
  }, [client, conversationId, historyPageSize, organizationId, replaceMessages]);

  const loadOlderMessages = useCallback(async () => {
    const activeSession = sessionRef.current;
    if (!activeSession || !historyCursor || isLoadingHistory) {
      return;
    }

    setIsLoadingHistory(true);
    try {
      const page = await client.getMessages(activeSession.conversationId, {
        cursor: historyCursor,
        limit: historyPageSize,
      });
      mergeMessages(page.messages);
      setHistoryCursor(page.nextCursor);
      setHasMoreHistory(page.hasMore);
      setError(null);
    } catch (unknownError) {
      setError(getErrorMessage(unknownError));
    } finally {
      setIsLoadingHistory(false);
    }
  }, [client, historyCursor, historyPageSize, isLoadingHistory, mergeMessages]);

  const catchUpMessages = useCallback(
    async (afterSequenceNumber: number) => {
      const activeSession = sessionRef.current;
      if (!activeSession) {
        return;
      }

      try {
        const page = await client.getMessages(activeSession.conversationId, {
          afterSequenceNumber,
          limit: historyPageSize,
        });
        mergeMessages(page.messages);
        setError(null);
      } catch (unknownError) {
        setError(getErrorMessage(unknownError));
      }
    },
    [client, historyPageSize, mergeMessages],
  );

  const processQueue = useCallback(async () => {
    const queue = queueRef.current;
    const activeSession = sessionRef.current;
    if (!queue || !activeSession || queue.isEmpty() || queue.isFlushing()) {
      return;
    }

    setIsSending(true);
    const latestSequenceNumber = getLatestSequenceNumber(messagesRef.current);
    const result = await queue.flush(
      (item) =>
        client.sendMessage({
          conversationId: item.conversationId,
          endpointId: item.endpointId,
          idempotencyKey: item.idempotencyKey,
          organizationId: item.organizationId,
          text: item.text,
          visitorSessionId: item.visitorSessionId,
        }),
      {
        onSent(_item, message) {
          // Дедупликация: id серверного сообщения = idempotency_key, поэтому
          // merge по id заменяет оптимистичную реплику без создания дубля.
          mergeMessages([message]);
        },
        onFailed(item) {
          setMessages((currentMessages) => {
            const nextMessages = updateWebChatMessageStatus(
              currentMessages,
              item.idempotencyKey,
              "failed",
            );
            messagesRef.current = nextMessages;
            return nextMessages;
          });
        },
      },
    );
    setIsSending(false);

    if (result.sent.length > 0) {
      // Догоняем ленту после переотправки: подтягиваем ответы менеджера и
      // восстанавливаем порядок по sequence_number без пропусков (§7.10).
      await catchUpMessages(latestSequenceNumber);
    }

    if (result.failure) {
      setError(getErrorMessage(result.failure.error));
      return;
    }

    setError(null);
    if (!queue.isEmpty()) {
      // Реплики, добавленные во время flush, отправляем следующим проходом.
      void processQueue();
    }
  }, [catchUpMessages, client, mergeMessages]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    if (!session) {
      queueRef.current = null;
      return;
    }

    const queue = createOutboundQueue({
      conversationId: session.conversationId,
      storage: outboundQueueStorage,
    });
    queueRef.current = queue;

    // Восстанавливаем буфер исходящих после перезагрузки/повторного монтирования:
    // возвращаем оптимистичные реплики в ленту и переотправляем накопленное.
    const bufferedMessages = queue
      .items()
      .map((item) => createOptimisticMessage(item));
    if (bufferedMessages.length > 0) {
      mergeMessages(bufferedMessages);
    }
    void processQueue();

    return () => {
      if (queueRef.current === queue) {
        queueRef.current = null;
      }
    };
  }, [mergeMessages, outboundQueueStorage, processQueue, session]);

  useEffect(() => {
    if (!session || !realtimeEnabled) {
      return;
    }

    if (!webSocketFactory && typeof WebSocket !== "function") {
      setConnectionState("offline");
      return;
    }

    const realtimeClient = createWebChatRealtimeClient({
      conversationId: session.conversationId,
      initialSequenceNumber: getLatestSequenceNumber(messagesRef.current),
      organizationId: session.organizationId,
      reconnectDelayMs: realtimeReconnectDelayMs,
      url: resolveRealtimeUrl(edge.apiBaseUrl, edge.realtimeUrl),
      visitorSessionId: session.visitorSessionId,
      webSocketFactory,
      onConnectionState(state) {
        setConnectionState(state);
        if (state === "online") {
          // Соединение через Edge восстановлено — переотправляем буфер (CP-7).
          void processQueue();
        }
      },
      onEvent(event) {
        if (event.type === "message.created") {
          if (event.message.conversationId !== session.conversationId) {
            return;
          }
        } else if (
          "conversationId" in event &&
          event.conversationId !== session.conversationId
        ) {
          return;
        }

        if (event.type === "typing.started") {
          setTypingNames((currentNames) =>
            currentNames.includes(event.displayName ?? "Клиент")
              ? currentNames
              : [...currentNames, event.displayName ?? "Клиент"],
          );
          return;
        }

        if (event.type === "typing.stopped") {
          setTypingNames((currentNames) =>
            currentNames.filter((name) => name !== (event.displayName ?? "Клиент")),
          );
          return;
        }

        setMessages((currentMessages) => {
          const nextMessages = applyRealtimeEventToMessages(currentMessages, event);
          messagesRef.current = nextMessages;
          return nextMessages;
        });
      },
      onReconnect({ afterSequenceNumber }) {
        void catchUpMessages(afterSequenceNumber);
      },
      onSequenceGap({ afterSequenceNumber }) {
        void catchUpMessages(afterSequenceNumber);
      },
    });

    realtimeClient.start();

    return () => {
      realtimeClient.stop();
    };
  }, [
    catchUpMessages,
    edge,
    processQueue,
    realtimeEnabled,
    realtimeReconnectDelayMs,
    session,
    webSocketFactory,
  ]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedText = messageText.trim();
    const activeSession = sessionRef.current;
    const queue = queueRef.current;
    if (!trimmedText || !activeSession || !queue) {
      return;
    }

    // Кладём реплику в буфер (стабильный idempotency_key) и оптимистично
    // показываем её в ленте — даже при разрыве она не потеряется (CP-7).
    const item = queue.enqueue({
      conversationId: activeSession.conversationId,
      endpointId: activeSession.endpointId,
      organizationId: activeSession.organizationId,
      visitorSessionId: activeSession.visitorSessionId,
      text: trimmedText,
    });
    mergeMessages([createOptimisticMessage(item)]);
    setMessageText("");
    inputRef.current?.focus();
    void processQueue();
  }

  return (
    <WidgetShell aria-labelledby="bridge-chat-title">
      <header className="bridge-chat-header">
        <div>
          <p className="bridge-chat-kicker">web_chat</p>
          <h1 id="bridge-chat-title">{title}</h1>
          <p
            aria-label="Состояние соединения Web Chat"
            aria-live="polite"
            className="bridge-chat-connection"
            id="bridge-chat-connection-status"
            role="status"
          >
            {formatConnectionState(connectionState)}
            {edge.viaEdge ? " · через Edge" : ""}
          </p>
        </div>
        <IconButton aria-label="Свернуть виджет" title="Свернуть виджет">
          <span aria-hidden="true">-</span>
        </IconButton>
      </header>

      <main
        aria-atomic="false"
        aria-busy={isLoading || isLoadingHistory}
        aria-label="Лента Web Chat"
        aria-live="polite"
        aria-relevant="additions text"
        className="bridge-chat-thread"
        onScroll={(event) => {
          void handleThreadScroll(event, loadOlderMessages, hasMoreHistory);
        }}
        role="log"
      >
        {isLoading ? (
          <p className="bridge-chat-system-state">Загрузка сообщений...</p>
        ) : null}

        {!isLoading && hasMoreHistory ? (
          <button
            className="bridge-chat-history-button"
            disabled={isLoadingHistory}
            onClick={() => {
              void loadOlderMessages();
            }}
            type="button"
          >
            {isLoadingHistory ? "Загрузка..." : "Загрузить предыдущие"}
          </button>
        ) : null}

        {!isLoading && messages.length === 0 ? (
          <p className="bridge-chat-system-state">Пока нет сообщений</p>
        ) : null}

        {messages.map((message) => (
          <article
            className={`bridge-chat-message bridge-chat-message-${message.author.type}`}
            key={message.id}
          >
            <p className="bridge-chat-message-author">
              {message.author.displayName}
            </p>
            <p className="bridge-chat-message-text">{message.body.text}</p>
            <footer className="bridge-chat-message-meta">
              <time dateTime={message.createdAt}>
                {formatMessageTime(message.createdAt)}
              </time>
              {message.author.type === "visitor" && message.status ? (
                <span>{formatStatus(message.status)}</span>
              ) : null}
            </footer>
          </article>
        ))}

        {typingNames.length > 0 ? (
          <p className="bridge-chat-typing" aria-live="polite">
            {formatTypingNames(typingNames)}
          </p>
        ) : null}
      </main>

      {error ? (
        <p className="bridge-chat-error" role="alert">
          {error}
        </p>
      ) : null}

      <form
        aria-label="Отправка сообщения Web Chat"
        className="bridge-chat-form"
        onSubmit={handleSubmit}
      >
        <label className="bridge-chat-input-label" htmlFor="bridge-chat-input">
          Сообщение
        </label>
        <textarea
          aria-describedby="bridge-chat-connection-status"
          id="bridge-chat-input"
          name="message"
          onChange={(event) => setMessageText(event.target.value)}
          placeholder="Напишите сообщение"
          ref={inputRef}
          rows={2}
          value={messageText}
        />
        <PrimaryButton
          disabled={isSending || !session || messageText.trim().length === 0}
        >
          {isSending ? "Отправка" : "Отправить"}
        </PrimaryButton>
      </form>
    </WidgetShell>
  );
}

function createOptimisticMessage(item: OutboundQueueItem): WebChatMessage {
  return {
    id: item.idempotencyKey,
    idempotencyKey: item.idempotencyKey,
    organizationId: item.organizationId,
    conversationId: item.conversationId,
    endpointId: item.endpointId,
    channel: "web_chat",
    author: {
      type: "visitor",
      displayName: "Посетитель",
    },
    body: {
      type: "text",
      text: item.text,
    },
    createdAt: item.createdAt,
    status: "queued",
  };
}

function formatMessageTime(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Неизвестная ошибка Web Chat";
}

function formatStatus(status: WebChatMessage["status"]): string {
  switch (status) {
    case "queued":
      return "в очереди";
    case "received":
      return "получено";
    case "routed":
      return "в обработке";
    case "sent":
      return "отправлено";
    case "delivered":
      return "доставлено";
    case "read":
      return "прочитано";
    case "failed":
      return "ошибка";
    default:
      return "";
  }
}

function formatConnectionState(
  state: "connecting" | "online" | "reconnecting" | "offline",
): string {
  switch (state) {
    case "connecting":
      return "подключение";
    case "online":
      return "онлайн";
    case "reconnecting":
      return "переподключение";
    case "offline":
      return "офлайн";
  }
}

function formatTypingNames(names: string[]): string {
  return `${names.join(", ")} печатает...`;
}

async function handleThreadScroll(
  event: UIEvent<HTMLElement>,
  loadOlderMessages: () => Promise<void>,
  hasMoreHistory: boolean,
) {
  if (hasMoreHistory && event.currentTarget.scrollTop <= 24) {
    await loadOlderMessages();
  }
}
