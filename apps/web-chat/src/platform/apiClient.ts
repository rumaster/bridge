import type { WebChatMessage } from "../types";

export const DEFAULT_API_BASE_URL = "/api/v1";
export const DEFAULT_CONVERSATION_ID = "web-chat-m0-demo-conversation";
export const DEFAULT_ORGANIZATION_ID = "web-chat-m0-demo-organization";

type Fetcher = typeof fetch;

export type SendMessageInput = {
  conversationId: string;
  organizationId: string;
  text: string;
};

export type WebChatApiClient = {
  getMessages: (conversationId: string) => Promise<WebChatMessage[]>;
  sendMessage: (input: SendMessageInput) => Promise<WebChatMessage>;
};

export type WebChatApiClientOptions = {
  baseUrl?: string;
  fetcher?: Fetcher;
};

// TODO(SVC-CHAT M1): заменить локальную заглушку на @bridge/api-client,
// когда пакет начнет экспортировать сгенерированный C3.messages клиент.
export function createWebChatApiClient(
  options: WebChatApiClientOptions = {},
): WebChatApiClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_API_BASE_URL);
  const fetcher = options.fetcher ?? fetch;

  return {
    async getMessages(conversationId) {
      const response = await fetcher(
        `${baseUrl}/conversations/${encodeURIComponent(conversationId)}/messages`,
      );

      if (!response.ok) {
        throw new Error(`Cannot load web chat messages: ${response.status}`);
      }

      return (await response.json()) as WebChatMessage[];
    },

    async sendMessage(input) {
      const response = await fetcher(`${baseUrl}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          channel: "web_chat",
          conversation_id: input.conversationId,
          organization_id: input.organizationId,
          body: {
            type: "text",
            text: input.text,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Cannot send web chat message: ${response.status}`);
      }

      return (await response.json()) as WebChatMessage;
    },
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}
