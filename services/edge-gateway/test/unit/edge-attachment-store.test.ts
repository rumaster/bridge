import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  AttachmentTooLargeError,
  createFilesystemAttachmentStore,
  parseAttachmentRef,
} from "../../src/edge-attachment-store.js";

const ORG = "00000000-0000-4000-8000-000000000101";

describe("filesystem attachment store", () => {
  let baseDir: string;

  before(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "edge-attach-"));
  });

  after(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("stores bytes and returns a content-hash storage_ref that round-trips", async () => {
    const store = createFilesystemAttachmentStore({ baseDir });
    const content = Buffer.from("hello attachment");

    const put = await store.put({ content, organizationId: ORG, mime: "text/plain", filename: "note.txt" });

    assert.equal(put.deduped, false);
    assert.equal(put.size, content.byteLength);
    assert.match(put.storageRef, /^edge-attach:\/\/00000000-0000-4000-8000-000000000101\/[0-9a-f]{64}$/);

    const got = await store.get(put.storageRef);
    assert.ok(got);
    assert.deepEqual(got.content, content);
    assert.equal(got.mime, "text/plain");
    assert.equal(got.filename, "note.txt");
    assert.equal(got.size, content.byteLength);
  });

  it("deduplicates identical bytes by content hash (same ref, single write)", async () => {
    const store = createFilesystemAttachmentStore({ baseDir });
    const content = Buffer.from("dedup me");

    const first = await store.put({ content, organizationId: ORG });
    const second = await store.put({ content, organizationId: ORG });

    assert.equal(first.storageRef, second.storageRef);
    assert.equal(first.deduped, false);
    assert.equal(second.deduped, true);
  });

  it("different bytes get different refs", async () => {
    const store = createFilesystemAttachmentStore({ baseDir });
    const a = await store.put({ content: Buffer.from("aaa"), organizationId: ORG });
    const b = await store.put({ content: Buffer.from("bbb"), organizationId: ORG });
    assert.notEqual(a.storageRef, b.storageRef);
  });

  it("rejects oversized attachments with AttachmentTooLargeError (bytes not written)", async () => {
    const store = createFilesystemAttachmentStore({ baseDir, maxBytes: 4 });
    await assert.rejects(
      () => store.put({ content: Buffer.from("too many bytes"), organizationId: ORG }),
      (error: unknown) => error instanceof AttachmentTooLargeError,
    );
  });

  it("returns null for missing objects and foreign/broken refs", async () => {
    const store = createFilesystemAttachmentStore({ baseDir });
    assert.equal(await store.get(`edge-attach://${ORG}/${"0".repeat(64)}`), null);
    assert.equal(await store.get("s3://bucket/object"), null);
    assert.equal(await store.get("not-a-ref"), null);
  });

  it("canResolve only accepts well-formed edge-attach refs", () => {
    const store = createFilesystemAttachmentStore({ baseDir });
    assert.equal(store.canResolve(`edge-attach://${ORG}/${"a".repeat(64)}`), true);
    assert.equal(store.canResolve("edge-attach://org/short"), false);
    assert.equal(store.canResolve("email-attachment://legacy"), false);
  });

  it("parseAttachmentRef extracts org and hash, rejects malformed", () => {
    const ref = `edge-attach://${ORG}/${"f".repeat(64)}`;
    assert.deepEqual(parseAttachmentRef(ref), { organizationId: ORG, contentHash: "f".repeat(64) });
    assert.equal(parseAttachmentRef("edge-attach://org-only"), null);
    assert.equal(parseAttachmentRef(42), null);
  });
});
