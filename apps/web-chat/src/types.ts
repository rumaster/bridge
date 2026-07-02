export type WebChatAuthorType = "visitor" | "manager" | "system";

export type WebChatMessageStatus = "sent" | "delivered" | "read";

export type WebChatMessage = {
  id: string;
  organizationId: string;
  conversationId: string;
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
