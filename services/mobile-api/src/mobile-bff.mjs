import { MOBILE_API_VERSION } from "../../../packages/contracts/src/mobile.mjs";

import {
  aggregateDialogList,
  aggregateDialogMessages,
  aggregateNotifications,
  toMobileNotification,
} from "./aggregators.mjs";
import { createMockBackendApi } from "./backend-client.mjs";
import { createDeviceRegistry } from "./device-registry.mjs";
import {
  assertDeviceRegistrationRequest,
  assertSendMessageRequest,
} from "./mobile-dto.mjs";
import { mapNotificationToPushPayload } from "./push-payload.mjs";
import { createPushDispatcher } from "./push-dispatcher.mjs";
import { createMockPushProvider } from "./push-provider.mjs";
import { createRealtimeConsumer } from "./realtime-consumer.mjs";
import { createSyncEngine } from "./sync-engine.mjs";

const DEFAULT_CONTEXT = Object.freeze({
  organizationId: "org-1",
  userId: "manager-1",
  deviceId: "device-mobile-1",
  roles: ["manager"],
  locale: "ru-RU",
});

/**
 * Реальный BFF SVC-MOB (M4): собирает «экранные» ответы из мок-Backend (C3.* и
 * C10) через агрегаторы, отдаёт оффлайн-sync по дельтам/курсору, идемпотентную
 * отправку (idempotency_key = message_id, §11.12), регистрацию устройств и push,
 * потребление realtime C7 и приём RF-клиентов из Edge-буфера (§19.5).
 *
 * Поверхность методов совпадает с детерминированным M0-моком, поэтому BFF
 * подключается в тот же HTTP-сервер как `mobileApi`. Ответы честно помечены
 * `mock: false`, режим — `bff`. Здесь нет бизнес-логики — только композиция и
 * проксирование к апстрим-контрактам (границы §1).
 */
export function createMobileBff(options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const context = { ...DEFAULT_CONTEXT, ...(options.context ?? {}) };
  const backend = options.backend ?? createMockBackendApi({ now });
  const deviceRegistry = options.deviceRegistry ?? createDeviceRegistry({ now });
  const pushProvider = options.pushProvider ?? createMockPushProvider({ now });
  const wsChannel = options.wsChannel ?? null;

  const pushDispatcher = createPushDispatcher({
    provider: pushProvider,
    registry: deviceRegistry,
  });
  const syncEngine = createSyncEngine({ backend, context, now });
  const realtimeConsumer = createRealtimeConsumer({
    backend,
    pushDispatcher,
    registry: deviceRegistry,
  });

  const metrics = {
    auth_proxy_total: 0,
    dialogs_list_total: 0,
    messages_list_total: 0,
    messages_send_total: 0,
    messages_dedup_total: 0,
    notifications_list_total: 0,
    sync_total: 0,
    devices_registered_total: 0,
    devices_revoked_total: 0,
  };

  const api = {
    mode: "bff",

    startTelegramLogin(payload = {}) {
      metrics.auth_proxy_total += 1;
      return {
        contract: "MOBILE.AuthProxyResponse",
        version: MOBILE_API_VERSION,
        request_id: payload.request_id ?? "req-mobile-auth-start",
        proxied_to: "C3.auth",
        upstream_operation: "POST /auth/login/telegram/start",
        status: "accepted",
        mock: false,
      };
    },

    verifyTelegramLogin(payload = {}) {
      metrics.auth_proxy_total += 1;
      return sessionResponse(payload.request_id ?? "req-mobile-auth-verify");
    },

    logout() {
      metrics.auth_proxy_total += 1;
      return {
        contract: "MOBILE.LogoutResponse",
        version: MOBILE_API_VERSION,
        proxied_to: "C3.auth",
        status: "ok",
        mock: false,
      };
    },

    getSession() {
      metrics.auth_proxy_total += 1;
      return sessionResponse("req-mobile-session");
    },

    listDialogs() {
      metrics.dialogs_list_total += 1;
      const organizationId = context.organizationId;
      const conversations = backend.listConversations({ organizationId });
      const messagesByConversation = new Map();
      const clientsById = new Map();

      for (const conversation of conversations) {
        messagesByConversation.set(
          conversation.id,
          backend.listConversationMessages({ organizationId, conversationId: conversation.id }),
        );
        if (conversation.client_id && !clientsById.has(conversation.client_id)) {
          const client = backend.getClient({ organizationId, clientId: conversation.client_id });
          if (client) {
            clientsById.set(conversation.client_id, client);
          }
        }
      }

      return {
        contract: "MOBILE.DialogListResponse",
        version: MOBILE_API_VERSION,
        source_contracts: ["C3.conversations", "C3.messages", "C3.clients"],
        items: aggregateDialogList({ conversations, messagesByConversation, clientsById }),
        next_cursor: null,
        mock: false,
      };
    },

    listMessages(dialogId) {
      metrics.messages_list_total += 1;
      const messages = backend.listConversationMessages({
        organizationId: context.organizationId,
        conversationId: dialogId,
      });

      return {
        contract: "MOBILE.DialogMessagesResponse",
        version: MOBILE_API_VERSION,
        dialog_id: dialogId,
        source_contracts: ["C3.conversations", "C3.messages"],
        items: aggregateDialogMessages({ messages }),
        next_cursor: null,
        mock: false,
      };
    },

    sendMessage(payload) {
      const request = assertSendMessageRequest(payload);
      metrics.messages_send_total += 1;

      const result = backend.sendMessage({
        organizationId: request.organization_id,
        conversationId: request.conversation_id,
        messageId: request.message_id,
        idempotencyKey: request.idempotency_key,
        senderType: "manager",
        senderUserId: request.sender_user_id,
        text: request.text,
        occurredAt: request.client_generated_at ?? now(),
      });

      if (result.duplicate) {
        metrics.messages_dedup_total += 1;
      }

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
        duplicate: result.duplicate,
        sequence_number: result.message.sequence_number,
        accepted_at: now(),
        mock: false,
      };
    },

    listNotifications() {
      metrics.notifications_list_total += 1;
      const notifications = backend.listNotifications({
        organizationId: context.organizationId,
        recipientUserId: context.userId,
      });

      return {
        contract: "MOBILE.NotificationListResponse",
        version: MOBILE_API_VERSION,
        source_contracts: ["C10.notifications"],
        items: aggregateNotifications({ notifications }),
        next_cursor: null,
        mock: false,
      };
    },

    sync(query) {
      metrics.sync_total += 1;
      return syncEngine.sync(query);
    },

    registerDevice(payload) {
      const request = assertDeviceRegistrationRequest(payload);
      const device = deviceRegistry.register({
        organizationId: request.organization_id,
        userId: request.user_id,
        deviceId: request.device_id,
        platform: request.platform,
        pushProvider: request.push_provider,
        pushToken: request.push_token,
        appVersion: request.app_version,
        locale: request.locale,
      });
      metrics.devices_registered_total += 1;

      return {
        contract: "MOBILE.RegisterDeviceResponse",
        version: MOBILE_API_VERSION,
        request_id: request.request_id,
        device,
        push_payload_stub: buildPushStub(device),
        mock: false,
      };
    },

    revokeDevice(deviceId) {
      const device = deviceRegistry.revoke(deviceId);
      metrics.devices_revoked_total += 1;

      return {
        contract: "MOBILE.RevokeDeviceResponse",
        version: MOBILE_API_VERSION,
        device_id: deviceId,
        status: "revoked",
        revoked_at: device.revoked_at,
        mock: false,
      };
    },

    // --- Realtime/Edge поверхность для integration/e2e (не HTTP-роуты) ---

    /** Потребление одного C7-события (message/notification/typing). */
    handleRealtimeEvent(event) {
      return realtimeConsumer.handleEvent(event);
    },

    /** Подписка на мок-WS канал (реплей после курсора + живой поток). */
    connectRealtime(subscriptionOptions) {
      if (!wsChannel) {
        throw new Error("mobile BFF has no WS channel configured");
      }
      return realtimeConsumer.connect(wsChannel, subscriptionOptions);
    },

    /** Приём батча RF-сообщений из Edge-буфера (порядок/дедуп — на стороне Edge). */
    ingestEdgeBatch(messages) {
      return backend.ingestEdgeBatch(messages);
    },

    // Подкомпоненты доступны тестам для точечных проверок.
    backend,
    deviceRegistry,
    pushProvider,
    pushDispatcher,
    realtimeConsumer,
    syncEngine,
    context,

    getMetrics() {
      return mergeMetrics(metrics, [
        ["backend", backend.getMetrics()],
        ["sync", syncEngine.getMetrics()],
        ["device", deviceRegistry.getMetrics()],
        ["push", pushDispatcher.getMetrics()],
        ["provider", pushProvider.getMetrics()],
        ["realtime", realtimeConsumer.getMetrics()],
      ]);
    },
  };

  return api;

  function sessionResponse(requestId) {
    return {
      contract: "MOBILE.AuthSessionResponse",
      version: MOBILE_API_VERSION,
      request_id: requestId,
      proxied_to: "C3.auth",
      authenticated: true,
      session: {
        organization_id: context.organizationId,
        user_id: context.userId,
        roles: context.roles ?? ["manager"],
        locale: context.locale ?? "ru-RU",
        issued_at: now(),
      },
      mock: false,
    };
  }

  // Демонстрационный push-payload при регистрации: маппинг последнего уведомления
  // получателя (или синтетического «device registered») на формат FCM/APNs.
  function buildPushStub(device) {
    const [latest] = backend.listNotifications({
      organizationId: device.organization_id,
      recipientUserId: device.user_id,
      limit: 1,
    });
    const mobileNotification = latest
      ? toMobileNotification(latest)
      : registrationStub(device);
    return mapNotificationToPushPayload(mobileNotification, device);
  }

  function registrationStub(device) {
    return {
      notification_id: `device-registered:${device.device_id}`,
      organization_id: device.organization_id,
      user_id: device.user_id,
      title: "Device registered",
      body: "Push notifications are enabled for this device.",
      severity: "info",
      data: { device_id: device.device_id },
      created_at: now(),
      read_at: null,
    };
  }
}

// Плоская сводка метрик: под-компоненты снабжаются префиксом (без удвоения, если
// ключ уже с ним начинается), базовые BFF-счётчики не перезаписываются.
function mergeMetrics(base, groups) {
  const out = { ...base };
  for (const [prefix, source] of groups) {
    for (const [key, value] of Object.entries(source)) {
      const name = key.startsWith(`${prefix}_`) ? key : `${prefix}_${key}`;
      if (name in out) {
        continue;
      }
      out[name] = value;
    }
  }
  return out;
}
