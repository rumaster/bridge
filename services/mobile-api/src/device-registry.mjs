/**
 * Реестр устройств/push-токенов SVC-MOB (M4, ТЗ §19.4). Единственная доменная
 * сущность, которой владеет SVC-MOB (§4): регистрация устройства (`POST
 * /mobile/v1/devices`), отзыв (`DELETE`), деактивация «мёртвых» токенов и учёт
 * онлайн-присутствия для fallback «нет WS → push».
 *
 * Изоляция арендатора — устройство несёт organization_id/user_id. Детерминирован.
 */
export function createDeviceRegistry({ now = () => new Date().toISOString() } = {}) {
  const devices = new Map();
  const metrics = {
    registered_total: 0,
    revoked_total: 0,
    deactivated_total: 0,
    online_total: 0,
    offline_total: 0,
  };

  function isUsable(device) {
    return Boolean(device) && device.active && device.revoked_at === null;
  }

  return {
    register({
      organizationId,
      userId,
      deviceId,
      platform,
      pushProvider,
      pushToken,
      appVersion,
      locale,
    }) {
      const existing = devices.get(deviceId);
      const device = {
        organization_id: organizationId,
        user_id: userId,
        device_id: deviceId,
        platform,
        push_provider: pushProvider,
        push_token: pushToken,
        app_version: appVersion ?? null,
        locale: locale ?? null,
        created_at: existing?.created_at ?? now(),
        last_seen_at: now(),
        revoked_at: null,
        active: true,
        online: existing?.online ?? false,
        deactivated_reason: null,
      };
      devices.set(deviceId, device);
      metrics.registered_total += 1;
      return { ...device };
    },

    revoke(deviceId) {
      const existing = devices.get(deviceId);
      const device = {
        ...(existing ?? {
          organization_id: null,
          user_id: null,
          device_id: deviceId,
          platform: null,
          push_provider: null,
          push_token: null,
          app_version: null,
          locale: null,
          created_at: now(),
          deactivated_reason: null,
        }),
        last_seen_at: now(),
        revoked_at: now(),
        active: false,
        online: false,
      };
      devices.set(deviceId, device);
      metrics.revoked_total += 1;
      return { ...device };
    },

    /** Деактивация из-за «мёртвого» токена (провайдер вернул unregistered). */
    deactivate(deviceId, reason = "dead_token") {
      const existing = devices.get(deviceId);
      if (!existing) {
        return null;
      }
      existing.active = false;
      existing.online = false;
      existing.deactivated_reason = reason;
      metrics.deactivated_total += 1;
      return { ...existing };
    },

    markOnline(deviceId) {
      const device = devices.get(deviceId);
      if (!isUsable(device)) {
        return null;
      }
      device.online = true;
      device.last_seen_at = now();
      metrics.online_total += 1;
      return { ...device };
    },

    markOffline(deviceId) {
      const device = devices.get(deviceId);
      if (!device) {
        return null;
      }
      device.online = false;
      device.last_seen_at = now();
      metrics.offline_total += 1;
      return { ...device };
    },

    get(deviceId) {
      const device = devices.get(deviceId);
      return device ? { ...device } : null;
    },

    /** Активные (не отозванные, не деактивированные) устройства пользователя. */
    getActiveDevices(userId) {
      return [...devices.values()]
        .filter((device) => device.user_id === userId && isUsable(device))
        .map((device) => ({ ...device }));
    },

    getUserDevices(userId) {
      return [...devices.values()]
        .filter((device) => device.user_id === userId)
        .map((device) => ({ ...device }));
    },

    /** Есть ли у пользователя живое WS-присутствие (иначе — fallback на push). */
    hasOnlineDevice(userId) {
      return [...devices.values()].some(
        (device) => device.user_id === userId && isUsable(device) && device.online,
      );
    },

    all() {
      return [...devices.values()].map((device) => ({ ...device }));
    },

    getMetrics() {
      return { ...metrics };
    },
  };
}
