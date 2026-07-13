import { describe, expect, it } from "vitest";

import { createSaasAdminApiClient } from "../src/api/client/http";

/**
 * M5 «Bridge Mail» (docs/plan/mail-service-selfhosted.md): заказ ящика из админки —
 * backend создаёт ящик и сразу подключает его как email-канал. Клиент бьёт в
 * POST /api/v1/mail/mailboxes (MSW-обработчик), проверяем контракт ответа.
 */
describe("SaaS Administration — M5 Bridge Mail заказ ящика", () => {
  it("создаёт ящик и возвращает подключённый email-канал", async () => {
    const api = createSaasAdminApiClient({ baseUrl: "/api/v1" });

    const result = await api.channels.orderMailbox({ local_part: "support" });

    expect(result.address).toBe("support@mail.example.com");
    expect(result.channel.channel_type).toBe("email");
    expect(result.channel.status).toBe("connected");
    expect(result.channel.name).toContain("support@mail.example.com");
  });

  it("отклоняет некорректное имя ящика (с @/пробелом)", async () => {
    const api = createSaasAdminApiClient({ baseUrl: "/api/v1" });

    await expect(api.channels.orderMailbox({ local_part: "bad name@" })).rejects.toBeTruthy();
  });
});
