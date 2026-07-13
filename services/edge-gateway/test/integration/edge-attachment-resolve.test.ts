import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { createFilesystemAttachmentStore } from "../../src/edge-attachment-store.js";
import { createEdgeGatewayServer } from "../../src/server.js";

/**
 * Резолв байтов вложения на Edge (§4.3): backend-прокси лениво тянет
 * `GET /internal/edge/attachments?ref=…`, Edge отдаёт байты из хранилища.
 * Байты остаются на RF, уходят только по запросу менеджера.
 */

describe("edge attachment resolve route", () => {
  let server: any;
  let baseUrl: string;

  const ref = `edge-attach://00000000-0000-4000-8000-000000000101/${"a".repeat(64)}`;
  const attachmentStore = {
    async get(storageRef: string) {
      if (storageRef !== ref) {
        return null;
      }
      const content = Buffer.from("PDF-BYTES");
      return { content, mime: "application/pdf", filename: "счёт.pdf", size: content.byteLength };
    },
  };

  before(async () => {
    server = createEdgeGatewayServer({ attachmentStore });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error: any) => (error ? reject(error) : resolve())),
    );
  });

  it("streams the bytes with content-type and a filename disposition", async () => {
    const response = await fetch(`${baseUrl}/internal/edge/attachments?ref=${encodeURIComponent(ref)}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/pdf");
    const disposition = response.headers.get("content-disposition") ?? "";
    assert.match(disposition, /filename\*=UTF-8''/);
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(body.toString(), "PDF-BYTES");
  });

  it("returns 404 for an unknown storage_ref", async () => {
    const missing = `edge-attach://00000000-0000-4000-8000-000000000101/${"0".repeat(64)}`;
    const response = await fetch(`${baseUrl}/internal/edge/attachments?ref=${encodeURIComponent(missing)}`);
    assert.equal(response.status, 404);
  });

  it("returns 400 when ref is missing", async () => {
    const response = await fetch(`${baseUrl}/internal/edge/attachments`);
    assert.equal(response.status, 400);
  });

  it("returns 404 when no attachment store is configured", async () => {
    const bare: any = createEdgeGatewayServer({});
    await new Promise((resolve) => bare.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${bare.address().port}`;
    try {
      const response = await fetch(`${url}/internal/edge/attachments?ref=${encodeURIComponent(ref)}`);
      assert.equal(response.status, 404);
    } finally {
      await new Promise<void>((resolve) => bare.close(() => resolve()));
    }
  });
});

/**
 * Загрузка байтов ИСХОДЯЩЕГО вложения (§4.3-bis follow-up п.2): backend-прокси
 * кладёт файл менеджера на RF-том Edge `POST /internal/edge/attachments`, получает
 * непрозрачный `storage_ref`. Затем те же байты резолвятся обратно тем же стором —
 * замыкание upload → put → get.
 */
describe("edge attachment upload route", () => {
  const org = "00000000-0000-4000-8000-000000000101";
  let server: any;
  let baseUrl: string;
  let baseDir: string;

  before(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "edge-attach-upload-"));
    const store = createFilesystemAttachmentStore({ baseDir, maxBytes: 64 });
    server = createEdgeGatewayServer({ attachmentStore: store });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(baseDir, { recursive: true, force: true });
  });

  it("stores uploaded bytes and returns a resolvable storage_ref", async () => {
    const bytes = Buffer.from("OUTGOING-ATTACHMENT");
    const uploadUrl =
      `${baseUrl}/internal/edge/attachments?organization_id=${org}` +
      `&filename=${encodeURIComponent("отчёт.pdf")}&mime=application/pdf`;
    const upload = await fetch(uploadUrl, {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: bytes,
    });
    assert.equal(upload.status, 201);
    const body = (await upload.json()) as { storage_ref: string; size: number; deduped: boolean };
    assert.match(body.storage_ref, new RegExp(`^edge-attach://${org}/[0-9a-f]{64}$`));
    assert.equal(body.size, bytes.byteLength);
    assert.equal(body.deduped, false);

    // Те же байты читаются обратно через resolve-маршрут.
    const resolved = await fetch(
      `${baseUrl}/internal/edge/attachments?ref=${encodeURIComponent(body.storage_ref)}`,
    );
    assert.equal(resolved.status, 200);
    assert.equal(resolved.headers.get("content-type"), "application/pdf");
    assert.equal(Buffer.from(await resolved.arrayBuffer()).toString(), "OUTGOING-ATTACHMENT");

    // Повторная загрузка тех же байтов — дедуп по content-hash.
    const again = await fetch(uploadUrl, {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: bytes,
    });
    assert.equal(again.status, 201);
    assert.equal(((await again.json()) as { deduped: boolean }).deduped, true);
  });

  it("returns 400 without organization_id and 413 when over the size limit", async () => {
    const noOrg = await fetch(`${baseUrl}/internal/edge/attachments`, {
      method: "POST",
      body: Buffer.from("x"),
    });
    assert.equal(noOrg.status, 400);

    const tooBig = await fetch(
      `${baseUrl}/internal/edge/attachments?organization_id=${org}`,
      { method: "POST", body: Buffer.alloc(65, 1) },
    );
    assert.equal(tooBig.status, 413);
  });
});
