import { MOBILE_API_VERSION } from "../../../packages/contracts/src/mobile.js";

export function mapNotificationToPushPayload(notification, device, { ttlSeconds = 3600 } = {}) {
  assertRecord(notification, "notification");
  assertRecord(device, "device");

  const notificationId = expectString(notification.notification_id, "notification.notification_id");
  const organizationId = expectString(notification.organization_id, "notification.organization_id");
  const userId = expectString(notification.user_id, "notification.user_id");
  const title = expectString(notification.title, "notification.title");
  const body = expectString(notification.body, "notification.body");
  const provider = expectString(device.push_provider, "device.push_provider");
  const token = expectString(device.push_token, "device.push_token");

  if (device.organization_id !== organizationId) {
    throw new TypeError("device.organization_id must match notification.organization_id.");
  }

  if (device.user_id !== userId) {
    throw new TypeError("device.user_id must match notification.user_id.");
  }

  const data = stringifyData({
    ...(isRecord(notification.data) ? notification.data : {}),
    notification_id: notificationId,
    organization_id: organizationId,
    user_id: userId,
    severity: notification.severity ?? "info",
  });

  if (provider === "fcm") {
    return {
      contract: "MOBILE.PushPayloadStub",
      version: MOBILE_API_VERSION,
      provider: "fcm",
      device_id: device.device_id,
      notification_id: notificationId,
      ttl_seconds: ttlSeconds,
      payload: {
        token,
        notification: {
          title,
          body,
        },
        data,
        android: {
          priority: "high",
          ttl: `${ttlSeconds}s`,
        },
      },
    };
  }

  if (provider === "apns") {
    return {
      contract: "MOBILE.PushPayloadStub",
      version: MOBILE_API_VERSION,
      provider: "apns",
      device_id: device.device_id,
      notification_id: notificationId,
      ttl_seconds: ttlSeconds,
      payload: {
        token,
        aps: {
          alert: {
            title,
            body,
          },
          sound: "default",
          badge: Number.isInteger(notification.badge) ? notification.badge : 1,
        },
        custom: data,
      },
    };
  }

  throw new TypeError("device.push_provider must be fcm or apns.");
}

function stringifyData(data) {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, stringifyValue(value)]),
  );
}

function stringifyValue(value) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

function expectString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
  return value;
}

function assertRecord(value, field) {
  if (!isRecord(value)) {
    throw new TypeError(`${field} must be an object.`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
