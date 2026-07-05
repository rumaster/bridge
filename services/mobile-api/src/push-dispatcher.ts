import { toMobileNotification } from "./aggregators.js";
import { mapNotificationToPushPayload } from "./push-payload.js";

/**
 * Диспетчер push SVC-MOB (M4, ТЗ §19.4, §15.4). Ретранслирует уведомление C10 на
 * активные устройства пользователя через мок-провайдер FCM/APNs:
 *  - ретраи при временной недоступности провайдера (retryable);
 *  - деактивация «мёртвых» токенов (unregistered — не подлежит ретраю);
 *  - изоляция арендатора — доставка только на устройства той же организации.
 */
export function createPushDispatcher({
  provider,
  registry,
  maxAttempts = 3,
}) {
  const metrics = {
    push_dispatched_total: 0,
    push_delivered_total: 0,
    push_failed_total: 0,
    push_retry_total: 0,
    push_token_deactivated_total: 0,
    push_no_device_total: 0,
  };

  function dispatchToDevice(device, mobileNotification) {
    const payload = mapNotificationToPushPayload(mobileNotification, device);
    let attempts = 0;
    let last;

    while (attempts < maxAttempts) {
      attempts += 1;
      last = provider.send(payload);

      if (last.ok) {
        metrics.push_delivered_total += 1;
        return {
          device_id: device.device_id,
          provider: payload.provider,
          status: "delivered",
          attempts,
          provider_ref: last.provider_ref,
        };
      }

      if (!last.retryable) {
        registry.deactivate(device.device_id, last.reason);
        metrics.push_token_deactivated_total += 1;
        return {
          device_id: device.device_id,
          provider: payload.provider,
          status: "deactivated",
          attempts,
          reason: last.reason,
        };
      }

      metrics.push_retry_total += 1;
    }

    metrics.push_failed_total += 1;
    return {
      device_id: device.device_id,
      provider: payload.provider,
      status: "failed",
      attempts,
      reason: last?.reason ?? "unknown",
    };
  }

  return {
    dispatchToUser(userId, notification) {
      metrics.push_dispatched_total += 1;
      const mobileNotification = normalizeNotification(notification);
      const devices = registry
        .getActiveDevices(userId)
        .filter((device) => device.organization_id === mobileNotification.organization_id);

      if (devices.length === 0) {
        metrics.push_no_device_total += 1;
      }

      const results = devices.map((device) => dispatchToDevice(device, mobileNotification));
      return { notification_id: mobileNotification.notification_id, results };
    },

    getMetrics() {
      return { ...metrics };
    },
  };
}

function normalizeNotification(notification) {
  if (notification.notification_id && notification.user_id && notification.severity) {
    return notification;
  }
  return toMobileNotification(notification);
}
