import assert from "node:assert/strict";
import { mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import {
  AttachmentTooLargeError,
  createFilesystemAttachmentStore,
  parseAttachmentRef,
} from "../../src/edge-attachment-store.js";

const ORG = "00000000-0000-4000-8000-000000000101";

/** Сдвигает mtime файла объекта (и sidecar) в прошлое на `ageMs`, чтобы TTL сработал. */
async function ageObject(baseDir: string, storageRef: string, ageMs: number): Promise<void> {
  const parsed = parseAttachmentRef(storageRef);
  assert.ok(parsed);
  const file = join(baseDir, parsed.organizationId, parsed.contentHash);
  const when = new Date(Date.now() - ageMs);
  await utimes(file, when, when);
}

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

describe("filesystem attachment store — sweep (retention/GC)", () => {
  // Каждый тест получает свой изолированный том: TTL здесь измеряется в единицах
  // мс, поэтому объекты соседних тестов не должны пересекаться.
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "edge-attach-gc-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("keeps objects younger than TTL, deletes older ones with their sidecar", async () => {
    const store = createFilesystemAttachmentStore({ baseDir });
    const fresh = await store.put({ content: Buffer.from("fresh bytes"), organizationId: ORG });
    const stale = await store.put({
      content: Buffer.from("stale bytes to reclaim"),
      organizationId: ORG,
      mime: "text/plain",
      filename: "old.txt",
    });
    // Состарим только один объект на 10 дней.
    await ageObject(baseDir, stale.storageRef, 10 * 24 * 60 * 60 * 1000);

    const result = await store.sweep({ ttlMs: 7 * 24 * 60 * 60 * 1000 });

    assert.equal(result.scanned, 2);
    assert.equal(result.deleted, 1);
    assert.equal(result.kept, 0);
    assert.equal(result.reclaimedBytes, stale.size);
    assert.equal(result.errors, 0);

    // Просроченный удалён (байты + sidecar), свежий на месте.
    assert.equal(await store.get(stale.storageRef), null);
    await assert.rejects(() => stat(join(baseDir, ORG, `${parseHash(stale.storageRef)}.meta.json`)));
    assert.ok(await store.get(fresh.storageRef));
  });

  it("protects live (still-referenced) objects via isLive despite TTL expiry", async () => {
    const store = createFilesystemAttachmentStore({ baseDir });
    const live = await store.put({ content: Buffer.from("live dedup object"), organizationId: ORG });
    const dead = await store.put({ content: Buffer.from("orphaned object"), organizationId: ORG });
    await ageObject(baseDir, live.storageRef, 30 * 24 * 60 * 60 * 1000);
    await ageObject(baseDir, dead.storageRef, 30 * 24 * 60 * 60 * 1000);

    const liveRefs = new Set([live.storageRef]);
    const result = await store.sweep({
      ttlMs: 1,
      isLive: (ref) => liveRefs.has(ref),
    });

    assert.equal(result.deleted, 1);
    assert.equal(result.kept, 1);
    assert.ok(await store.get(live.storageRef), "referenced object must survive");
    assert.equal(await store.get(dead.storageRef), null, "orphaned object must be reclaimed");
  });

  it("treats an isLive error as 'alive' and does not delete", async () => {
    const store = createFilesystemAttachmentStore({ baseDir });
    const obj = await store.put({ content: Buffer.from("uncertain liveness"), organizationId: ORG });
    await ageObject(baseDir, obj.storageRef, 30 * 24 * 60 * 60 * 1000);

    const result = await store.sweep({
      ttlMs: 1,
      isLive: () => {
        throw new Error("control-plane unreachable");
      },
    });

    assert.equal(result.deleted, 0);
    assert.equal(result.kept, 1);
    assert.ok(await store.get(obj.storageRef));
  });

  it("is a no-op on a never-written volume and on ttlMs<0", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "edge-attach-empty-"));
    const store = createFilesystemAttachmentStore({ baseDir: emptyDir });
    // Каталог пуст (put ещё не создал ни одной папки org) — свип не падает.
    assert.deepEqual(await store.sweep({ ttlMs: 0 }), {
      scanned: 0,
      deleted: 0,
      kept: 0,
      reclaimedBytes: 0,
      errors: 0,
    });
    await rm(emptyDir, { recursive: true, force: true });

    // Отрицательный TTL — защитный no-op (ничего не удаляем).
    const store2 = createFilesystemAttachmentStore({ baseDir });
    const obj = await store2.put({ content: Buffer.from("guard"), organizationId: ORG });
    await ageObject(baseDir, obj.storageRef, 99 * 24 * 60 * 60 * 1000);
    const result = await store2.sweep({ ttlMs: -1 });
    assert.equal(result.deleted, 0);
    assert.ok(await store2.get(obj.storageRef));
  });
});

function parseHash(storageRef: string): string {
  const parsed = parseAttachmentRef(storageRef);
  assert.ok(parsed);
  return parsed.contentHash;
}
