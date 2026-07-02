import {
  MOBILE_API_VERSION,
} from "../../../packages/contracts/src/mobile.mjs";
import {
  assertDeviceRegistrationRequest,
  assertSendMessageRequest,
  assertSyncRequestQuery,
} from "./mobile-dto.mjs";
import { mapNotificationToPushPayload } from "./push-payload.mjs";
import { assertSyncCursor, createSyncCursor } from "./sync-cursor.mjs";

const MOCK_ORGANIZATION_ID = "org-1";
const MOCK_USER_ID = "manager-1";
const MOCK_DEVICE_ID = "device-mock-1";

export function createDeterministicMobileApiMock({
  now = () => new Date().toISOString(),
} = {}) {
  const registeredDevices = new Map();
  const metrics = {
    auth_proxy_total: 0,
    dialogs_list_total: 0,
    messages_list_total: 0,
    messages_send_total: 0,
    notifications_list_total: 0,
    sync_total: 0,
    devices_registered_total: 0,
    devices_revoked_total: 0,
  };

  return {
    startTelegramLogin(payload = {}) {
      metrics.auth_proxy_total += 1;
      return {
        contract: "MOBILE.AuthProxyResponse",
        version: MOBILE_API_VERSION,
        request_id: payload.request_id ?? "req-mobile-auth-start",
        proxied_to: "C3.auth",
        upstream_operation: "POST /auth/login/telegram/start",
        status: "accepted",
        mock: true,
      };
    },

    verifyTelegramLogin(payload = {}) {
      metrics.auth_proxy_total += 1;
      return createSessionResponse(payload.request_id ?? "req-mobile-auth-verify", now);
    },

    logout() {
      metrics.auth_proxy_total += 1;
      return {
        contract: "MOBILE.LogoutResponse",
        version: MOBILE_API_VERSION,
        proxied_to: "C3.auth",
        status: "ok",
        mock: true,
      };
    },

    getSession() {
      metrics.auth_proxy_total += 1;
      return createSessionResponse("req-mobile-session", now);
    },

    listDialogs() {
      metrics.dialogs_list_total += 1;
      return {
        contract: "MOBILE.DialogListResponse",
        version: MOBILE_API_VERSION,
        source_contracts: ["C3.conversations", "C3.messages", "C3.clients"],
        items: createDialogs(now),
        next_cursor: null,
        mock: true,
      };
    },

    listMessages(dialogId) {
      metrics.messages_list_total += 1;
      return {
        contract: "MOBILE.DialogMessagesResponse",
        version: MOBILE_API_VERSION,
        dialog_id: dialogId,
        source_contracts: ["C3.conversations", "C3.messages"],
        items: createMessages(dialogId, now),
        next_cursor: null,
        mock: true,
      };
    },

    sendMessage(payload) {
      const request = assertSendMessageRequest(payload);
      metrics.messages_send_total += 1;

      return {
        contract: "MOBILE.SendMessageResponse",
        version: MOBILE_API_VERSION,
        request_id: request.request_id,
        organization_id: request.organization_id,
        message_id: request.message_id,
        idempotency_key: request.idempotency_key,
        proxied_to: "C3.messages",
        upstream_operation: "POST /messages",
        status: "accepted",
        accepted_at: now(),
        mock: true,
      };
    },

    listNotifications() {
      metrics.notifications_list_total += 1;
      return {
        contract: "MOBILE.NotificationListResponse",
        version: MOBILE_API_VERSION,
        source_contracts: ["C10.notifications"],
        items: createNotifications(now),
        next_cursor: null,
        mock: true,
      };
    },

    sync(query) {
      const request = assertSyncRequestQuery(query);
      const previous = request.cursor ? assertSyncCursor(request.cursor) : null;
      const sequence = previous ? previous.sequence + 1 : 1;
      const organizationId = previous?.organization_id ?? MOCK_ORGANIZATION_ID;
      const userId = previous?.user_id ?? MOCK_USER_ID;
      const deviceId = request.device_id ?? previous?.device_id ?? MOCK_DEVICE_ID;
      const nextCursor = createSyncCursor({
        organizationId,
        userId,
        deviceId,
        sequence,
        issuedAt: now(),
      });

      metrics.sync_total += 1;

      return {
        contract: "MOBILE.SyncResponse",
        version: MOBILE_API_VERSION,
        previous_cursor: request.cursor,
        cursor: nextCursor,
        has_more: false,
        limit: request.limit,
        source_contracts: ["C3.conversations", "C3.messages", "C7", "C10.notifications"],
        deltas: {
          dialogs: previous ? [] : createDialogs(now),
          messages: previous ? [] : createMessages("dialog-1", now),
          notifications: previous ? [] : createNotifications(now),
          statuses: [
            {
              kind: "sync.watermark",
              sequence,
              occurred_at: now(),
            },
          ],
        },
        mock: true,
      };
    },

    registerDevice(payload) {
      const request = assertDeviceRegistrationRequest(payload);
      const device = {
        organization_id: request.organization_id,
        user_id: request.user_id,
        device_id: request.device_id,
        platform: request.platform,
        push_provider: request.push_provider,
        push_token: request.push_token,
        app_version: request.app_version,
        locale: request.locale,
        created_at: now(),
        last_seen_at: now(),
        revoked_at: null,
      };
      registeredDevices.set(request.device_id, device);
      metrics.devices_registered_total += 1;

      return {
        contract: "MOBILE.RegisterDeviceResponse",
        version: MOBILE_API_VERSION,
        request_id: request.request_id,
        device,
        push_payload_stub: mapNotificationToPushPayload(createNotifications(now)[0], device),
        mock: true,
      };
    },

    revokeDevice(deviceId) {
      const existing = registeredDevices.get(deviceId);
      const revokedAt = now();
      const device = existing
        ? {
            ...existing,
            revoked_at: revokedAt,
          }
        : {
            organization_id: MOCK_ORGANIZATION_ID,
            user_id: MOCK_USER_ID,
            device_id: deviceId,
            revoked_at: revokedAt,
          };

      registeredDevices.set(deviceId, device);
      metrics.devices_revoked_total += 1;

      return {
        contract: "MOBILE.RevokeDeviceResponse",
        version: MOBILE_API_VERSION,
        device_id: deviceId,
        status: "revoked",
        revoked_at: revokedAt,
        mock: true,
      };
    },

    getMetrics() {
      return { ...metrics };
    },
  };
}

function createSessionResponse(requestId, now) {
  return {
    contract: "MOBILE.AuthSessionResponse",
    version: MOBILE_API_VERSION,
    request_id: requestId,
    proxied_to: "C3.auth",
    authenticated: true,
    session: {
      organization_id: MOCK_ORGANIZATION_ID,
      user_id: MOCK_USER_ID,
      roles: ["manager"],
      locale: "ru-RU",
      issued_at: now(),
    },
    mock: true,
  };
}

function createDialogs(now) {
  return [
    {
      dialog_id: "dialog-1",
      conversation_id: "conversation-1",
      organization_id: MOCK_ORGANIZATION_ID,
      client: {
        client_id: "client-1",
        display_name: "Ada Customer",
      },
      last_message: {
        message_id: "message-2",
        sender_type: "client",
        text: "Can I change the delivery time?",
        occurred_at: now(),
      },
      unread_count: 2,
      updated_at: now(),
    },
  ];
}

function createMessages(dialogId, now) {
  return [
    {
      message_id: "message-1",
      dialog_id: dialogId,
      conversation_id: "conversation-1",
      sender_type: "manager",
      text: "Hello, how can I help?",
      sequence_number: 1,
      status: "delivered",
      occurred_at: now(),
    },
    {
      message_id: "message-2",
      dialog_id: dialogId,
      conversation_id: "conversation-1",
      sender_type: "client",
      text: "Can I change the delivery time?",
      sequence_number: 2,
      status: "received",
      occurred_at: now(),
    },
  ];
}

function createNotifications(now) {
  return [
    {
      notification_id: "notification-1",
      organization_id: MOCK_ORGANIZATION_ID,
      user_id: MOCK_USER_ID,
      title: "New client message",
      body: "Ada Customer sent a message.",
      severity: "info",
      data: {
        dialog_id: "dialog-1",
        conversation_id: "conversation-1",
      },
      created_at: now(),
      read_at: null,
    },
  ];
}
