import { createJsonApiClient } from "@bridge/api-client";
import type { WebChatMessage, WebChatSession } from "../types";

export const DEFAULT_API_BASE_URL = "/api/v1";
export const DEFAULT_ORGANIZATION_ID = "22345678-1234-4234-8234-123456789abc";
export const DEFAULT_CONVERSATION_ID = "32345678-1234-4234-8234-123456789abc";
export const DEFAULT_ENDPOINT_ID = "42345678-1234-4234-8234-123456789abc";

type Fetcher = typeof fetch;

export type CreateOrResumeSessionInput = {
  organizationId: string;
  visitorSessionId?: string | null;
  conversationId?: string;
};

export type SendMessageInput = {
  conversationId: string;
  endpointId: string;
  idempotencyKey: string;
  organizationId: string;
  text: string;
  visitorSessionId: string;
};

export type WebChatApiClient = {
  createOrResumeSession: (
    input: CreateOrResumeSessionInput,
  ) => Promise<WebChatSession>;
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
    async createOrResumeSession(input) {
      return requestJson<WebChatSession>("/web-chat/sessions", {
        method: "POST",
        body: JSON.stringify(
          omitUndefined({
            channel: "web_chat",
            organization_id: input.organizationId,
            visitor_session_id: input.visitorSessionId ?? undefined,
            conversation_id: input.conversationId,
          }),
        ),
      });
    },

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
          endpoint_id: input.endpointId,
          idempotency_key: input.idempotencyKey,
          organization_id: input.organizationId,
          visitor_session_id: input.visitorSessionId,
          body: {
            type: "text",
            text: input.text,
          },
        }),
        headers: {
          "idempotency-key": input.idempotencyKey,
        },
      });
    },
  };
}

function omitUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}
