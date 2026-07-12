import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createImapMailbox, type EdgeImapClient } from "../../src/edge-imap-mailbox.js";

const CREDENTIALS = {
  imap: { host: "imap.example.com", port: 993, tls: true, username: "support@example.com", password: "secret" },
  smtp: { host: "smtp.example.com" },
  from_email: "support@example.com",
};
const CHANNEL = { channelId: "chan-1", organizationId: "org-1" };

interface FakeMessage {
  uid: number;
  raw: string;
}

/** Инъектируемый IMAP-клиент: отдаёт RFC822-исходники, fetch фильтрует по UID-диапазону. */
function createFakeImapClient(messages: FakeMessage[], uidNext: number) {
  let connected = false;
  const store = [...messages];
  const client: EdgeImapClient & { push(msg: FakeMessage): void } = {
    usable: true,
    async connect() {
      connected = true;
    },
    async getMailboxLock() {
      if (!connected) {
        throw new Error("not connected");
      }
      return { release() {} };
    },
    get mailbox() {
      return { uidNext };
    },
    async *fetch(range: string) {
      const since = Number.parseInt(range.split(":")[0], 10) - 1;
      for (const message of store) {
        if (message.uid > since) {
          yield { uid: message.uid, source: Buffer.from(message.raw, "utf8") };
        }
      }
    },
    async logout() {
      this.usable = false;
    },
    close() {
      this.usable = false;
    },
    push(msg: FakeMessage) {
      store.push(msg);
    },
  };
  return client;
}

function rawEmail({
  from = "Client <client@example.com>",
  subject = "Тест",
  messageId = "<abc123@example.com>",
  body = "Привет, где заказ?",
}: { from?: string; subject?: string; messageId?: string; body?: string } = {}): string {
  return [
    `From: ${from}`,
    "To: support@example.com",
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    "Date: Wed, 12 Jul 2026 10:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
    "",
  ].join("\r\n");
}

describe("edge imap mailbox", () => {
  it("does not import history: first contact sets a baseline and returns nothing", async () => {
    const fake = createFakeImapClient([{ uid: 1, raw: rawEmail() }, { uid: 2, raw: rawEmail() }], 3);
    const mailbox = createImapMailbox({ credentials: CREDENTIALS, channel: CHANNEL }, { clientFactory: () => fake });

    const first = await mailbox.fetchNew({});
    assert.equal(first.length, 0, "историю ящика не принимаем");
  });

  it("returns only messages that arrive after the baseline, parsed from MIME", async () => {
    const fake = createFakeImapClient([{ uid: 1, raw: rawEmail() }, { uid: 2, raw: rawEmail() }], 3);
    const mailbox = createImapMailbox({ credentials: CREDENTIALS, channel: CHANNEL }, { clientFactory: () => fake });

    await mailbox.fetchNew({}); // фиксируем baseline = 2
    fake.push({ uid: 3, raw: rawEmail({ subject: "Заказ #42", messageId: "<m3@example.com>", body: "Где мой заказ?" }) });

    const next = await mailbox.fetchNew({});
    assert.equal(next.length, 1);
    const email = next[0];
    assert.equal(email.uid, 3);
    assert.equal(email.message_id, "m3@example.com"); // угловые скобки сняты
    assert.equal(email.from, "client@example.com");
    assert.equal(email.subject, "Заказ #42");
    assert.equal(email.text?.trim(), "Где мой заказ?");
    assert.equal(email.date, "2026-07-12T10:00:00.000Z");
  });

  it("advances by the driver-provided cursor (sinceUid)", async () => {
    const fake = createFakeImapClient(
      [
        { uid: 1, raw: rawEmail() },
        { uid: 2, raw: rawEmail() },
        { uid: 3, raw: rawEmail({ messageId: "<m3@example.com>" }) },
      ],
      4,
    );
    const mailbox = createImapMailbox({ credentials: CREDENTIALS, channel: CHANNEL }, { clientFactory: () => fake });

    const afterTwo = await mailbox.fetchNew({ sinceUid: 2 });
    assert.deepEqual(afterTwo.map((e) => e.uid), [3]);

    const afterThree = await mailbox.fetchNew({ sinceUid: 3 });
    assert.equal(afterThree.length, 0, "нет писем с UID > 3");
  });

  it("maps MIME attachments into RawEmail attachments", async () => {
    const boundary = "b0undary";
    const multipart = [
      "From: Client <client@example.com>",
      "To: support@example.com",
      "Subject: С вложением",
      "Message-ID: <att1@example.com>",
      "Date: Wed, 12 Jul 2026 10:00:00 +0000",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "смотри вложение",
      `--${boundary}`,
      'Content-Type: text/plain; name="note.txt"',
      "Content-Disposition: attachment; filename=\"note.txt\"",
      "",
      "hello",
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const fake = createFakeImapClient([{ uid: 10, raw: multipart }], 11);
    const mailbox = createImapMailbox({ credentials: CREDENTIALS, channel: CHANNEL }, { clientFactory: () => fake });

    const emails = await mailbox.fetchNew({ sinceUid: 9 });
    assert.equal(emails.length, 1);
    const [email] = emails;
    assert.equal(email.text?.trim(), "смотри вложение");
    assert.equal(email.attachments?.length, 1);
    assert.equal(email.attachments?.[0].filename, "note.txt");
    assert.ok(email.attachments?.[0].mime?.startsWith("text/plain"));
  });

  it("rejects credentials without an imap endpoint", () => {
    assert.throws(
      () => createImapMailbox({ credentials: { smtp: {} }, channel: CHANNEL }),
      /IMAP credentials require/,
    );
  });
});
