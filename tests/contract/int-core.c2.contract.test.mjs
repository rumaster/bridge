import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createCommunicationCoreMock } from "../../services/backend/src/modules/communication-core/mock-ingress-egress.mjs";

const root = process.cwd();

const validIngressMessage = {
  id: "12345678-1234-4234-8234-123456789abc",
  idempotency_key: "12345678-1234-4234-8234-123456789abc",
  organization_id: "22345678-1234-4234-8234-123456789abc",
  conversation_id: "32345678-1234-4234-8234-123456789abc",
  endpoint_id: "42345678-1234-4234-8234-123456789abc",
  channel: "telegram",
  direction: "inbound",
  sender_type: "client",
  sequence_number: 42,
  type: "text",
  content: {
    text: "ping",
  },
  status: "received",
  created_at: "2026-07-02T16:10:00.000Z",
  updated_at: "2026-07-02T16:10:00.000Z",
};

describe("INT <-> CORE C2 contract smoke", () => {
  it("publishes an OpenAPI contract for ingress and egress", () => {
    const contract = JSON.parse(
      readFileSync(join(root, "packages/contracts/openapi/communication-core-c2.openapi.json"), "utf8"),
    );

    assert.equal(contract.openapi, "3.1.0");
    assert.ok(contract.paths["/internal/ingress/messages"].post);
    assert.ok(contract.paths["/internal/egress/messages"].post);
  });

  it("accepts a valid adapter ingress message", () => {
    const core = createCommunicationCoreMock();
    const response = core.acceptIngressMessage(validIngressMessage);

    assert.equal(response.accepted, true);
    assert.equal(response.message_id, validIngressMessage.id);
  });

  it("rejects an invalid adapter ingress message", () => {
    const core = createCommunicationCoreMock();

    assert.throws(
      () => core.acceptIngressMessage({ ...validIngressMessage, sequence_number: 0 }),
      /sequence_number/,
    );
  });
});
