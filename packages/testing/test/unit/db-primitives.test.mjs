import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertEmbeddingVector,
  createDeterministicEmbedding,
  createTestKnowledgeChunk,
  createTestKnowledgeDocument,
  createTestClient,
  createTestConversation,
  createTestMessage,
  createTestOrganization,
  createTestUser,
  formatPgVector,
  TEST_EMBEDDING_DIMENSIONS,
} from "../../src/db/factories.mjs";
import {
  assertNonBlankText,
  assertPositiveInteger,
  assertUtcTimestamptz,
  assertUuid,
  isNonBlankText,
  isUtcTimestamptz,
  isUuid,
  toUtcTimestamptz,
} from "../../src/db/primitives.mjs";

describe("db primitive validators", () => {
  it("accepts RFC 4122 UUID values and rejects malformed values", () => {
    assert.equal(isUuid("00000000-0000-4000-8000-000000000001"), true);
    assert.equal(isUuid("00000000-0000-0000-0000-000000000001"), false);
    assert.equal(isUuid("not-a-uuid"), false);

    assert.equal(assertUuid("00000000-0000-4000-8000-000000000002"), "00000000-0000-4000-8000-000000000002");
    assert.throws(() => assertUuid("not-a-uuid"), /must be an RFC 4122 UUID/);
  });

  it("normalizes and validates UTC timestamptz strings", () => {
    assert.equal(toUtcTimestamptz("2026-01-01T03:00:00.000+03:00"), "2026-01-01T00:00:00.000Z");
    assert.equal(isUtcTimestamptz("2026-01-01T00:00:00.000Z"), true);
    assert.equal(isUtcTimestamptz("2026-01-01T00:00:00+00:00"), false);
    assert.equal(isUtcTimestamptz("not-a-date"), false);

    assert.equal(assertUtcTimestamptz("2026-01-01T00:00:00.000Z"), "2026-01-01T00:00:00.000Z");
    assert.throws(() => assertUtcTimestamptz("2026-01-01T00:00:00+00:00"), /ISO 8601 UTC/);
  });

  it("validates non-blank text and positive integers", () => {
    assert.equal(isNonBlankText("web_chat"), true);
    assert.equal(isNonBlankText("   "), false);
    assert.equal(assertNonBlankText("message.type"), "message.type");
    assert.throws(() => assertNonBlankText(""), /non-blank string/);

    assert.equal(assertPositiveInteger(1), 1);
    assert.throws(() => assertPositiveInteger(0), /positive safe integer/);
    assert.throws(() => assertPositiveInteger(1.5), /positive safe integer/);
  });
});

describe("db test factories", () => {
  it("creates organization and user fixtures with valid UUID and UTC timestamps", () => {
    const organization = createTestOrganization();
    const user = createTestUser({ organization_id: organization.id });

    assert.equal(isUuid(organization.id), true);
    assert.equal(isUtcTimestamptz(organization.created_at), true);
    assert.equal(isUuid(user.id), true);
    assert.equal(user.organization_id, organization.id);
    assert.equal(isUtcTimestamptz(user.created_at), true);
  });

  it("creates M1 client, conversation, and message fixtures", () => {
    const organization = createTestOrganization();
    const client = createTestClient({ organization_id: organization.id });
    const conversation = createTestConversation({
      organization_id: organization.id,
      client_id: client.id,
    });
    const message = createTestMessage({
      organization_id: organization.id,
      conversation_id: conversation.id,
      sequence_number: 7,
    });

    assert.equal(isUuid(client.id), true);
    assert.equal(client.organization_id, organization.id);
    assert.equal(conversation.client_id, client.id);
    assert.equal(message.conversation_id, conversation.id);
    assert.equal(message.sequence_number, 7);
    assert.equal(isUtcTimestamptz(message.created_at), true);

    assert.throws(() => createTestClient({ display_name: "" }), /non-blank string/);
    assert.throws(() => createTestConversation({ status: "archived" }), /conversation.status/);
    assert.throws(() => createTestMessage({ sequence_number: 0 }), /positive safe integer/);
  });

  it("creates M2 knowledge document, chunk, and deterministic embedding fixtures", () => {
    const organization = createTestOrganization();
    const document = createTestKnowledgeDocument({
      organization_id: organization.id,
      status: "indexed",
      indexed_at: "2026-01-01T00:00:00.000Z",
    });
    const embedding = createDeterministicEmbedding("kb:delivery-policy");
    const sameEmbedding = createDeterministicEmbedding("kb:delivery-policy");
    const chunk = createTestKnowledgeChunk({
      organization_id: organization.id,
      document_id: document.id,
      chunk_no: 3,
      embedding,
    });

    assert.equal(document.organization_id, organization.id);
    assert.equal(chunk.document_id, document.id);
    assert.equal(chunk.embedding.length, TEST_EMBEDDING_DIMENSIONS);
    assert.deepEqual(embedding, sameEmbedding);
    assert.equal(formatPgVector(embedding).startsWith("["), true);
    assert.equal(formatPgVector(embedding).endsWith("]"), true);

    assert.throws(() => createDeterministicEmbedding(""), /non-blank string/);
    assert.throws(() => assertEmbeddingVector([1, 2, 3]), /1536-dimension embedding/);
    assert.throws(() => createTestKnowledgeDocument({ status: "queued" }), /knowledge_document.status/);
    assert.throws(() => createTestKnowledgeChunk({ chunk_no: 0 }), /positive safe integer/);
  });
});
