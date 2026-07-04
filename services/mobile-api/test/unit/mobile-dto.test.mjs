import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MOBILE_API_VERSION } from "../../../../packages/contracts/src/mobile.mjs";
import {
  validateDeviceRegistrationRequest,
  validateSendMessageRequest,
  validateSyncRequestQuery,
} from "../../src/mobile-dto.mjs";
import { createSyncCursor } from "../../src/sync-cursor.mjs";

describe("MOBILE.v1 DTO validators", () => {
  it("accepts the frozen device registration DTO", () => {
    const result = validateDeviceRegistrationRequest({
      contract: "MOBILE.RegisterDeviceRequest",
      version: "1.0.0",
      request_id: "req-device-1",
      organization_id: "org-1",
      user_id: "manager-1",
      device_id: "device-1",
      platform: "android",
      push_provider: "fcm",
      push_token: "fcm-token-1",
      app_version: "1.0.0",
      locale: "ru-RU",
    });

    assert.equal(result.ok, true);
    assert.equal(result.value.push_provider, "fcm");
  });

  it("accepts both the previous published version and the current MOBILE.v1 minor", () => {
    const previous = validateSendMessageRequest({
      contract: "MOBILE.SendMessageRequest",
      version: "1.0.0",
      request_id: "req-message-old-client",
      organization_id: "org-1",
      conversation_id: "conversation-1",
      message_id: "message-old-client",
      idempotency_key: "message-old-client",
      sender_user_id: "manager-1",
      text: "Old published client still works",
    });
    const current = validateSendMessageRequest({
      contract: "MOBILE.SendMessageRequest",
      version: MOBILE_API_VERSION,
      request_id: "req-message-current-client",
      organization_id: "org-1",
      conversation_id: "conversation-1",
      message_id: "message-current-client",
      idempotency_key: "message-current-client",
      sender_user_id: "manager-1",
      text: "Current client works",
    });
    const unsupported = validateSendMessageRequest({
      contract: "MOBILE.SendMessageRequest",
      version: "2.0.0",
      request_id: "req-message-v2-client",
      organization_id: "org-1",
      conversation_id: "conversation-1",
      message_id: "message-v2-client",
      idempotency_key: "message-v2-client",
      sender_user_id: "manager-1",
      text: "Unsupported major",
    });

    assert.equal(previous.ok, true);
    assert.equal(current.ok, true);
    assert.equal(unsupported.ok, false);
    assert.match(unsupported.errors.map((error) => error.field).join(","), /version/);
  });

  it("rejects incompatible platform and push provider pairs", () => {
    const result = validateDeviceRegistrationRequest({
      contract: "MOBILE.RegisterDeviceRequest",
      version: "1.0.0",
      request_id: "req-device-1",
      organization_id: "org-1",
      user_id: "manager-1",
      device_id: "device-1",
      platform: "ios",
      push_provider: "fcm",
      push_token: "token-1",
    });

    assert.equal(result.ok, false);
    assert.match(result.errors.map((error) => error.field).join(","), /push_provider/);
  });

  it("accepts mobile message sends only when idempotency_key equals message_id", () => {
    const valid = validateSendMessageRequest({
      contract: "MOBILE.SendMessageRequest",
      version: "1.0.0",
      request_id: "req-message-1",
      organization_id: "org-1",
      conversation_id: "conversation-1",
      message_id: "message-1",
      idempotency_key: "message-1",
      sender_user_id: "manager-1",
      text: "  Hello  ",
      client_generated_at: "2026-07-02T16:30:00.000Z",
    });
    const invalid = validateSendMessageRequest({
      contract: "MOBILE.SendMessageRequest",
      version: "1.0.0",
      request_id: "req-message-1",
      organization_id: "org-1",
      conversation_id: "conversation-1",
      message_id: "message-1",
      idempotency_key: "other-key",
      sender_user_id: "manager-1",
      text: "Hello",
    });

    assert.equal(valid.ok, true);
    assert.equal(valid.value.text, "Hello");
    assert.equal(invalid.ok, false);
    assert.match(invalid.errors.map((error) => error.field).join(","), /idempotency_key/);
  });

  it("validates sync query cursor format and limit bounds", () => {
    const cursor = createSyncCursor({
      organizationId: "org-1",
      userId: "manager-1",
      deviceId: "device-1",
      sequence: 3,
      issuedAt: "2026-07-02T16:30:00.000Z",
    });

    const valid = validateSyncRequestQuery({
      cursor,
      device_id: "device-1",
      limit: "50",
    });
    const invalid = validateSyncRequestQuery({
      cursor: "not-a-cursor",
      limit: "0",
    });

    assert.equal(valid.ok, true);
    assert.equal(valid.value.limit, 50);
    assert.equal(invalid.ok, false);
    assert.match(invalid.errors.map((error) => error.field).join(","), /cursor/);
    assert.match(invalid.errors.map((error) => error.field).join(","), /limit/);
  });
});
