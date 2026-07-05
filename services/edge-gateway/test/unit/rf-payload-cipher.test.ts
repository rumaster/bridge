import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import {
  RF_PAYLOAD_KEY_BYTES,
  RfPayloadCipherError,
  createRfPayloadCipher,
  keysEqual,
  resolveRfPayloadKey,
} from "../../src/rf-payload-cipher.js";

const KEY = randomBytes(RF_PAYLOAD_KEY_BYTES);

const canonicalPayload = Object.freeze({
  id: "12345678-1234-4234-8234-123456789abc",
  idempotency_key: "12345678-1234-4234-8234-123456789abc",
  organization_id: "22345678-1234-4234-8234-123456789abc",
  endpoint_id: "42345678-1234-4234-8234-123456789abc",
  sequence_number: 7,
  type: "text",
  content: { text: "секрет РФ" },
  status: "received",
});

describe("RF payload cipher (шифрование payload_encrypted, CP-7 §7.9/§7.14)", () => {
  it("шифрует и дешифрует canonical payload без потерь (roundtrip)", () => {
    const cipher = createRfPayloadCipher({ key: KEY });

    const envelope = cipher.encrypt(canonicalPayload);
    assert.ok(Buffer.isBuffer(envelope), "payload_encrypted — это bytea/Buffer");

    const restored = cipher.decrypt(envelope);
    assert.deepEqual(restored, canonicalPayload);
  });

  it("не хранит открытый текст: шифртекст не содержит содержимого сообщения", () => {
    const cipher = createRfPayloadCipher({ key: KEY });
    const envelope = cipher.encrypt(canonicalPayload);

    assert.equal(envelope.includes(Buffer.from("секрет РФ", "utf8")), false);
    assert.equal(envelope.includes(Buffer.from(canonicalPayload.id, "utf8")), false);
  });

  it("рандомизирует IV: два шифрования одного payload дают разный шифртекст", () => {
    const cipher = createRfPayloadCipher({ key: KEY });

    const first = cipher.encrypt(canonicalPayload);
    const second = cipher.encrypt(canonicalPayload);

    assert.equal(first.equals(second), false, "IV должен быть случайным");
    assert.deepEqual(cipher.decrypt(first), cipher.decrypt(second));
  });

  it("обнаруживает искажение шифртекста через GCM auth tag", () => {
    const cipher = createRfPayloadCipher({ key: KEY });
    const envelope = cipher.encrypt(canonicalPayload);

    const tampered = Buffer.from(envelope);
    tampered[tampered.length - 1] ^= 0xff; // портим последний байт шифртекста

    assert.throws(() => cipher.decrypt(tampered), RfPayloadCipherError);
  });

  it("связывает запись через AAD: подмена endpoint/seq/idempotency ломает дешифрование", () => {
    const cipher = createRfPayloadCipher({ key: KEY });
    const aad = {
      endpoint_id: canonicalPayload.endpoint_id,
      sequence_number: canonicalPayload.sequence_number,
      idempotency_key: canonicalPayload.idempotency_key,
    };

    const envelope = cipher.encrypt(canonicalPayload, { aad });
    assert.deepEqual(cipher.decrypt(envelope, { aad }), canonicalPayload);

    assert.throws(
      () => cipher.decrypt(envelope, { aad: { ...aad, sequence_number: 999 } }),
      RfPayloadCipherError,
    );
  });

  it("не дешифруется чужим ключом", () => {
    const cipher = createRfPayloadCipher({ key: KEY });
    const other = createRfPayloadCipher({ key: randomBytes(RF_PAYLOAD_KEY_BYTES) });

    const envelope = cipher.encrypt(canonicalPayload);
    assert.throws(() => other.decrypt(envelope), RfPayloadCipherError);
  });

  it("требует ключ и валидирует его длину (AES-256)", () => {
    assert.throws(() => createRfPayloadCipher({}), RfPayloadCipherError);
    assert.throws(() => createRfPayloadCipher({ key: "" }), RfPayloadCipherError);
    assert.throws(
      () => createRfPayloadCipher({ key: randomBytes(16) }),
      /32 bytes/,
    );
  });

  it("принимает base64-ключ из секрет-менеджера (env)", () => {
    const base64Key = KEY.toString("base64");
    const key = resolveRfPayloadKey({ EDGE_BUFFER_ENCRYPTION_KEY: base64Key });

    assert.ok(keysEqual(key, KEY));

    const cipher = createRfPayloadCipher({ key: base64Key });
    assert.deepEqual(cipher.decrypt(cipher.encrypt(canonicalPayload)), canonicalPayload);
  });

  it("resolveRfPayloadKey падает, если ключ не сконфигурирован", () => {
    assert.throws(() => resolveRfPayloadKey({}), /not configured/);
  });
});
