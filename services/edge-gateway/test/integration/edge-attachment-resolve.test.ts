import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

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
