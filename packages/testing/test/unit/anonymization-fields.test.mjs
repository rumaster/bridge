import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CLIENT_ANONYMIZATION_FIELDS,
  validateClientAnonymizationFields,
} from "../../src/db/anonymization.mjs";

describe("client anonymization field manifest", () => {
  it("covers every client personal-data field required by M5", () => {
    const fields = validateClientAnonymizationFields();

    assert.equal(fields, CLIENT_ANONYMIZATION_FIELDS);
    assert.equal(fields.length, 14);
    assert.deepEqual(
      fields.map((field) => field.key),
      [
        "clients.display_name",
        "clients.anonymized_at",
        "communication_endpoints.external_id",
        "communication_endpoints.verified",
        "communication_endpoints.verified_at",
        "communication_endpoints.metadata",
        "client_identity_links.evidence",
        "client_identity_links.reverted_reason",
        "messages.content",
        "attachments.storage_ref",
        "attachments.metadata",
        "message_delivery_attempts.error",
        "client_notes.body",
        "client_tags.tag",
      ],
    );
  });

  it("rejects incomplete, duplicated, and malformed field sets", () => {
    assert.throws(
      () => validateClientAnonymizationFields([]),
      /non-empty array/,
    );
    assert.throws(
      () => validateClientAnonymizationFields([CLIENT_ANONYMIZATION_FIELDS[0]]),
      /missing required client anonymization field/,
    );
    assert.throws(
      () =>
        validateClientAnonymizationFields([
          ...CLIENT_ANONYMIZATION_FIELDS,
          CLIENT_ANONYMIZATION_FIELDS[0],
        ]),
      /duplicate client anonymization field/,
    );
    assert.throws(
      () =>
        validateClientAnonymizationFields([
          ...CLIENT_ANONYMIZATION_FIELDS,
          {
            key: "messages.payload",
            table: "messages",
            column: "content",
            action: "replace",
            personalDataClass: "communication_history",
          },
        ]),
      /must match table\.column/,
    );
  });
});
