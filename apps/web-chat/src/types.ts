export type WebChatAuthorType = "visitor" | "manager" | "system";

export type WebChatMessageStatus =
  | "received"
  | "routed"
  | "sent"
  | "delivered"
  | "read"
  | "failed";

export type WebChatSession = {
  visitorSessionId: string;
  organizationId: string;
  conversationId: string;
  endpointId: string;
};

export type WebChatMessage = {
  id: string;
  idempotencyKey?: string;
  organizationId: string;
  conversationId: string;
  endpointId?: string;
  channel: "web_chat";
  author: {
    type: WebChatAuthorType;
    displayName: string;
  };
  body: {
    type: "text";
    text: string;
  };
  createdAt: string;
  status?: WebChatMessageStatus;
};

export type WebChatRealtimeEvent =
  | {
      type: "message.created";
      payload: WebChatMessage;
    }
  | {
      type: "message.status_changed";
      payload: Pick<WebChatMessage, "id" | "status">;
    }
  | {
      type: "mock.connected";
      contract: "C7";
      channel: "web_chat";
    };

export type WebChatMountOptions = {
  apiBaseUrl?: string;
  conversationId?: string;
  organizationId?: string;
  title?: string;
  enableMockApi?: boolean;
};

export type WebChatInstance = {
  element: HTMLElement;
  unmount: () => void;
};
