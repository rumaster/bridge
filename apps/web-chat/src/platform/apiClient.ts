import { createJsonApiClient } from "@bridge/api-client";
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

export function createWebChatApiClient(
  options: WebChatApiClientOptions = {},
): WebChatApiClient {
  const { requestJson } = createJsonApiClient({
    baseUrl: options.baseUrl ?? DEFAULT_API_BASE_URL,
    fetcher: options.fetcher,
  });

  return {
    async getMessages(conversationId) {
      return requestJson<WebChatMessage[]>(
        `/conversations/${encodeURIComponent(conversationId)}/messages`,
      );
    },

    async sendMessage(input) {
      return requestJson<WebChatMessage>("/messages", {
        method: "POST",
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
    },
  };
}
