import {
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from "@nestjs/common";

import { AttachmentResolverService } from "../../src/modules/communication-core/attachment.service";
import {
  attachmentContentUrl,
  mapMessage,
  type MessageRow,
} from "../../src/modules/communication-core/communication-core.dto";

const ORG = "30000000-0000-4000-8000-000000000101";
const ATTACHMENT_ID = "40000000-0000-4000-8000-0000000000a1";
const STORAGE_REF = `edge-attach://${ORG}/${"a".repeat(64)}`;

function makeDatabase(row: unknown) {
  return {
    withTenant: async (_org: string, fn: (client: unknown) => Promise<unknown>) =>
      fn({
        query: async () => ({ rowCount: row ? 1 : 0, rows: row ? [row] : [] }),
      }),
  } as never;
}

describe("AttachmentResolverService", () => {
  const savedEnv = { ...process.env };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.EDGE_ATTACHMENT_URL = "http://edge.local/internal/edge/attachments";
    delete process.env.EDGE_CONTROL_URL;
    delete process.env.EDGE_CONTROL_TOKEN;
    fetchMock = jest.fn();
    (globalThis as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("resolves storage_ref and proxies the bytes from Edge", async () => {
    const database = makeDatabase({ storage_ref: STORAGE_REF, mime: "application/pdf", metadata: { filename: "счёт.pdf" } });
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ "content-type": "application/pdf" }),
      arrayBuffer: async () => Buffer.from("PDF-BYTES"),
    });

    const service = new AttachmentResolverService(database);
    const result = await service.resolve(ORG, ATTACHMENT_ID);

    expect(result.content.toString()).toBe("PDF-BYTES");
    expect(result.contentType).toBe("application/pdf");
    expect(result.filename).toBe("счёт.pdf");
    // Проксируем именно к Edge-URL с непрозрачным ref.
    const [calledUrl] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(
      `http://edge.local/internal/edge/attachments?ref=${encodeURIComponent(STORAGE_REF)}`,
    );
  });

  it("derives the Edge URL from EDGE_CONTROL_URL when EDGE_ATTACHMENT_URL is absent", async () => {
    delete process.env.EDGE_ATTACHMENT_URL;
    process.env.EDGE_CONTROL_URL = "http://edge.local/internal/edge/control/messages";
    const database = makeDatabase({ storage_ref: STORAGE_REF, mime: null, metadata: null });
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: async () => Buffer.from("PNG"),
    });

    const service = new AttachmentResolverService(database);
    await service.resolve(ORG, ATTACHMENT_ID);

    const [calledUrl] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(
      `http://edge.local/internal/edge/attachments?ref=${encodeURIComponent(STORAGE_REF)}`,
    );
  });

  it("404s when the attachment row is not found (no Edge call)", async () => {
    const service = new AttachmentResolverService(makeDatabase(null));
    await expect(service.resolve(ORG, ATTACHMENT_ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404s when Edge has metadata but no bytes (oversized/removed)", async () => {
    const database = makeDatabase({ storage_ref: STORAGE_REF, mime: null, metadata: null });
    fetchMock.mockResolvedValue({ status: 404, ok: false, headers: new Headers(), arrayBuffer: async () => Buffer.alloc(0) });
    const service = new AttachmentResolverService(database);
    await expect(service.resolve(ORG, ATTACHMENT_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("503s (not a false empty body) when no Edge resolver is configured", async () => {
    delete process.env.EDGE_ATTACHMENT_URL;
    delete process.env.EDGE_CONTROL_URL;
    const database = makeDatabase({ storage_ref: STORAGE_REF, mime: null, metadata: null });
    const service = new AttachmentResolverService(database);
    await expect(service.resolve(ORG, ATTACHMENT_ID)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("store (outgoing upload → Edge, §4.3-bis follow-up п.2)", () => {
    it("uploads bytes to Edge and returns the storage_ref descriptor", async () => {
      fetchMock.mockResolvedValue({
        status: 201,
        ok: true,
        json: async () => ({ storage_ref: STORAGE_REF, size: 9, content_hash: "a".repeat(64) }),
      });
      const service = new AttachmentResolverService(makeDatabase(null));

      const stored = await service.store(ORG, {
        content: Buffer.from("PDF-BYTES"),
        filename: "счёт.pdf",
        mime: "application/pdf",
      });

      expect(stored.storageRef).toBe(STORAGE_REF);
      expect(stored.size).toBe(9);
      expect(stored.contentHash).toBe("a".repeat(64));
      const [calledUrl, init] = fetchMock.mock.calls[0];
      // Байты уходят POST-ом на Edge с org/filename/mime в query.
      expect(String(calledUrl)).toContain("http://edge.local/internal/edge/attachments?");
      expect(String(calledUrl)).toContain(`organization_id=${ORG}`);
      expect(String(calledUrl)).toContain("filename=");
      expect(init.method).toBe("POST");
      expect(Buffer.isBuffer(init.body)).toBe(true);
    });

    it("maps a 413 from Edge to PayloadTooLargeException", async () => {
      fetchMock.mockResolvedValue({ status: 413, ok: false, json: async () => ({}) });
      const service = new AttachmentResolverService(makeDatabase(null));
      await expect(
        service.store(ORG, { content: Buffer.from("x") }),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
    });

    it("503s when no Edge storage is configured", async () => {
      delete process.env.EDGE_ATTACHMENT_URL;
      delete process.env.EDGE_CONTROL_URL;
      const service = new AttachmentResolverService(makeDatabase(null));
      await expect(
        service.store(ORG, { content: Buffer.from("x") }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe("mapMessage attachments (read path §4.3)", () => {
  function baseRow(overrides: Partial<MessageRow>): MessageRow {
    return {
      id: "50000000-0000-4000-8000-000000000601",
      organization_id: ORG,
      conversation_id: "50000000-0000-4000-8000-000000000501",
      endpoint_id: "50000000-0000-4000-8000-000000000401",
      channel: "email",
      direction: "inbound",
      sender_type: "client",
      sequence_number: 1,
      type: "file",
      content: { type: "file" },
      status: "routed",
      created_at: "2026-07-13T10:00:00.000Z",
      delivered_at: null,
      ...overrides,
    };
  }

  it("maps aggregated attachments to a manager-facing url", () => {
    const mapped = mapMessage(
      baseRow({
        attachments: [
          { id: ATTACHMENT_ID, kind: "file", mime: "application/pdf", size: 2048, metadata: { filename: "счёт.pdf" } },
        ],
      }),
    );
    expect(mapped.attachments).toHaveLength(1);
    const [attachment] = mapped.attachments!;
    expect(attachment.id).toBe(ATTACHMENT_ID);
    expect(attachment.name).toBe("счёт.pdf");
    expect(attachment.contentType).toBe("application/pdf");
    expect(attachment.sizeBytes).toBe(2048);
    expect(attachment.url).toBe(attachmentContentUrl(ATTACHMENT_ID));
  });

  it("omits attachments when the message has none", () => {
    expect(mapMessage(baseRow({ attachments: [] })).attachments).toBeUndefined();
    expect(mapMessage(baseRow({ attachments: null })).attachments).toBeUndefined();
  });

  it("falls back to the attachment id as name when filename metadata is absent", () => {
    const mapped = mapMessage(
      baseRow({ attachments: [{ id: ATTACHMENT_ID, kind: "file", mime: null, size: 10, metadata: null }] }),
    );
    expect(mapped.attachments![0].name).toBe(ATTACHMENT_ID);
    expect(mapped.attachments![0].contentType).toBeNull();
  });
});
