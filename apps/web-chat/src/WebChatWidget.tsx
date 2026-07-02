import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  createWebChatApiClient,
  DEFAULT_CONVERSATION_ID,
  DEFAULT_ORGANIZATION_ID,
} from "./platform/apiClient";
import { IconButton, PrimaryButton, WidgetShell } from "./platform/uiKit";
import type { WebChatMessage, WebChatMountOptions } from "./types";

export function WebChatWidget({
  apiBaseUrl,
  conversationId = DEFAULT_CONVERSATION_ID,
  organizationId = DEFAULT_ORGANIZATION_ID,
  title = "Bridge Web Chat",
}: WebChatMountOptions) {
  const client = useMemo(
    () => createWebChatApiClient({ baseUrl: apiBaseUrl }),
    [apiBaseUrl],
  );
  const [messages, setMessages] = useState<WebChatMessage[]>([]);
  const [messageText, setMessageText] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isActive = true;

    async function loadMessages() {
      try {
        const loadedMessages = await client.getMessages(conversationId);
        if (isActive) {
          setMessages(loadedMessages);
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
  }, [client, conversationId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedText = messageText.trim();
    if (!trimmedText || isSending) {
      return;
    }

    setIsSending(true);
    try {
      const sentMessage = await client.sendMessage({
        conversationId,
        organizationId,
        text: trimmedText,
      });
      setMessages((currentMessages) => [...currentMessages, sentMessage]);
      setMessageText("");
      setError(null);
    } catch (unknownError) {
      setError(getErrorMessage(unknownError));
    } finally {
      setIsSending(false);
    }
  }

  return (
    <WidgetShell>
      <header className="bridge-chat-header">
        <div>
          <p className="bridge-chat-kicker">web_chat</p>
          <h1>{title}</h1>
        </div>
        <IconButton aria-label="Свернуть виджет" title="Свернуть виджет">
          <span aria-hidden="true">-</span>
        </IconButton>
      </header>

      <main
        aria-label="Лента Web Chat"
        className="bridge-chat-thread"
        role="log"
      >
        {isLoading ? (
          <p className="bridge-chat-system-state">Загрузка сообщений...</p>
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
            <time dateTime={message.createdAt}>
              {formatMessageTime(message.createdAt)}
            </time>
          </article>
        ))}
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
          id="bridge-chat-input"
          name="message"
          onChange={(event) => setMessageText(event.target.value)}
          placeholder="Напишите сообщение"
          rows={2}
          value={messageText}
        />
        <PrimaryButton disabled={isSending || messageText.trim().length === 0}>
          {isSending ? "Отправка" : "Отправить"}
        </PrimaryButton>
      </form>
    </WidgetShell>
  );
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
