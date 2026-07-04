export type WebChatAuthorType = "visitor" | "manager" | "ai" | "system";

export type WebChatMessageStatus =
  // Клиентские статусы буфера исходящих (CP-7): "queued" — в очереди на
  // переотправку; "failed" — попытка не удалась, реплика ждёт восстановления.
  | "queued"
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
  sequenceNumber?: number;
  status?: WebChatMessageStatus;
};

export type WebChatMessagesPage = {
  messages: WebChatMessage[];
  nextCursor: string | null;
  hasMore: boolean;
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
      type: "typing.started" | "typing.stopped";
      payload: {
        conversationId: string;
        displayName?: string;
      };
    }
  | {
      type: "mock.connected";
      contract: "C7";
      channel: "web_chat";
    };

export type C7WebSocketEvent = {
  contract: "C7.WebSocketEvent";
  version: "1.0.0";
  event:
    | "message.created"
    | "message.status_changed"
    | "typing.started"
    | "typing.stopped";
  event_id: string;
  organization_id: string;
  subscription_id?: string;
  sequence_number: number;
  payload: Record<string, unknown>;
  occurred_at: string;
};

export type NormalizedWebChatRealtimeEvent =
  | {
      type: "message.created";
      eventId?: string;
      sequenceNumber?: number;
      message: WebChatMessage;
    }
  | {
      type: "message.status_changed";
      eventId?: string;
      sequenceNumber?: number;
      messageId: string;
      status: WebChatMessageStatus;
    }
  | {
      type: "typing.started" | "typing.stopped";
      eventId?: string;
      sequenceNumber?: number;
      conversationId: string;
      displayName?: string;
    };

export type WebChatWebSocketLike = {
  onclose: null | ((event: unknown) => void);
  onerror: null | ((event: unknown) => void);
  onmessage: null | ((event: { data: unknown }) => void);
  onopen: null | ((event: unknown) => void);
  close: () => void;
  send: (data: string) => void;
};

export type WebChatWebSocketFactory = (url: string) => WebChatWebSocketLike;

export type WebChatMountOptions = {
  apiBaseUrl?: string;
  conversationId?: string;
  organizationId?: string;
  title?: string;
  enableMockApi?: boolean;
  historyPageSize?: number;
  realtimeEnabled?: boolean;
  realtimeReconnectDelayMs?: number;
  realtimeUrl?: string;
  webSocketFactory?: WebChatWebSocketFactory;
  /**
   * База Edge Cluster для клиентов РФ (CP-7, ТЗ §18.7). Если задана — REST/WS
   * прозрачно идут через Edge; контракты не меняются.
   */
  edgeBaseUrl?: string;
  /** Хранилище буфера исходящих (по умолчанию sessionStorage вкладки). */
  outboundQueueStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
};

export type WebChatInstance = {
  element: HTMLElement;
  unmount: () => void;
};
