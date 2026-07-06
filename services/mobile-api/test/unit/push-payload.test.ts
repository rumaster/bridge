import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mapNotificationToPushPayload } from "../../src/push-payload.js";

const notification = {
  notification_id: "notification-1",
  organization_id: "org-1",
  user_id: "manager-1",
  title: "New message",
  body: "Ada Customer sent a message.",
  severity: "info",
  data: {
    dialog_id: "dialog-1",
  },
};

describe("notification to push payload stub", () => {
  it("maps C10 notifications to FCM payload shape", () => {
    const result = mapNotificationToPushPayload(notification, {
      organization_id: "org-1",
      user_id: "manager-1",
      device_id: "android-device-1",
      push_provider: "fcm",
      push_token: "fcm-token-1",
    });

    assert.equal(result.contract, "MOBILE.PushPayloadStub");
    assert.equal(result.provider, "fcm");
    assert.equal(result.payload.token, "fcm-token-1");
    assert.equal(result.payload.notification.title, "New message");
    assert.equal(result.payload.data.dialog_id, "dialog-1");
  });

  it("maps C10 notifications to APNs payload shape", () => {
    const result = mapNotificationToPushPayload(notification, {
      organization_id: "org-1",
      user_id: "manager-1",
      device_id: "ios-device-1",
      push_provider: "apns",
      push_token: "apns-token-1",
    });

    assert.equal(result.provider, "apns");
    assert.equal(result.payload.token, "apns-token-1");
    assert.equal(result.payload.aps.alert.body, "Ada Customer sent a message.");
    assert.equal(result.payload.custom.notification_id, "notification-1");
  });

  it("rejects cross-user notification delivery", () => {
    assert.throws(
      () =>
        mapNotificationToPushPayload(notification, {
          organization_id: "org-1",
          user_id: "other-user",
          device_id: "device-1",
          push_provider: "fcm",
          push_token: "token-1",
        }),
      /user_id/,
    );
  });
});
