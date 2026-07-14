import { describe, expect, it } from "vitest";

import { createSaasAdminApiClient } from "../src/api/client/http";
import type { CreateBroadcastRequest } from "../src/api/client/types";

const draftRequest: CreateBroadcastRequest = {
  name: "Осенняя рассылка",
  template: {
    type: "text",
    body: "Здравствуйте, {{name}}!",
    locale: "ru",
    variables: ["name"]
  },
  filter: {
    mode: "tags",
    channels: ["channel-web-chat-main"],
    tags: ["vip"]
  },
  schedule: { mode: "manual" },
  rate_limit: {
    messages_per_minute: 60,
    strategy: "fixed"
  }
};

describe("SaaS Administration MSW mocks — M4 Broadcast (C8, CP-6)", () => {
  it("отдаёт список кампаний и статистику доставки", async () => {
    const api = createSaasAdminApiClient({ baseUrl: "/api/v1" });

    const list = await api.broadcasts.listBroadcasts();
    expect(list).toMatchObject({ contract: "C8.ListBroadcastsResponse" });
    expect(list.items.map((item) => item.id)).toContain("broadcast-welcome");

    const stats = await api.broadcasts.getStats("broadcast-welcome");
    expect(stats).toMatchObject({
      contract: "C8.BroadcastStatsResponse",
      broadcast_id: "broadcast-welcome",
      stats: { prepared: 1200, sent: 1200, delivered: 1180, failed: 20 }
    });
  });

  it("создаёт черновик кампании и запускает её через фасад C8", async () => {
    const api = createSaasAdminApiClient({ baseUrl: "/api/v1" });

    const created = await api.broadcasts.createBroadcast(draftRequest);
    expect(created).toMatchObject({
      contract: "C8.CreateBroadcastResponse",
      broadcast: {
        id: "broadcast-created-1",
        status: "draft",
        name: "Осенняя рассылка"
      }
    });

    // Новый черновик появляется в списке первым.
    const afterCreate = await api.broadcasts.listBroadcasts();
    expect(afterCreate.items[0]?.id).toBe("broadcast-created-1");

    // Свежесозданная кампания стартует со «нулевой» статистикой.
    const initialStats = await api.broadcasts.getStats("broadcast-created-1");
    expect(initialStats.stats).toMatchObject({ prepared: 0, sent: 0, delivered: 0, failed: 0 });

    // Немедленный запуск переводит кампанию в статус running и отдаёт core-черновик доставки.
    const started = await api.broadcasts.startBroadcast("broadcast-created-1", {
      mode: "immediate"
    });
    expect(started).toMatchObject({
      contract: "C8.StartBroadcastResponse",
      broadcast: { id: "broadcast-created-1", status: "running" },
      degraded: false,
      fallback_reason: null,
      core_delivery_draft: { transport: "core:C1/C2", mode: "immediate" },
      state_changed_event: { type: "broadcast.state_changed", status: "running" }
    });
  });

  it("планирует кампанию и требует scheduled_for для режима scheduled", async () => {
    const api = createSaasAdminApiClient({ baseUrl: "/api/v1" });

    const scheduled = await api.broadcasts.startBroadcast("broadcast-promo-july", {
      mode: "scheduled",
      scheduled_for: "2026-07-12T08:00:00.000Z"
    });
    expect(scheduled.broadcast.status).toBe("scheduled");

    await expect(
      api.broadcasts.startBroadcast("broadcast-promo-july", {
        mode: "scheduled"
      })
    ).rejects.toThrow();
  });

  it("отклоняет черновик без обязательных полей", async () => {
    const api = createSaasAdminApiClient({ baseUrl: "/api/v1" });

    await expect(
      api.broadcasts.createBroadcast({ ...draftRequest, name: " " })
    ).rejects.toThrow();
  });
});

describe("SaaS Administration MSW mocks — M4 Notification (C10, CP-8)", () => {
  it("отдаёт ленту, настройки и отмечает уведомление прочитанным", async () => {
    const api = createSaasAdminApiClient({ baseUrl: "/api/v1" });

    const feed = await api.notifications.listNotifications();
    expect(feed).toMatchObject({ contract: "C10.ListNotificationsResponse" });
    expect(feed.items.map((item) => item.id)).toContain("notif-channel-telegram-error");

    const read = await api.notifications.markRead("notif-channel-telegram-error");
    expect(read).toMatchObject({
      contract: "C10.MarkNotificationReadResponse",
      notification: { id: "notif-channel-telegram-error", status: "read" }
    });
    expect(read.notification.read_at).not.toBeNull();
  });

  it("меняет настройки каналов доставки через фасад C10 (web + telegram)", async () => {
    const api = createSaasAdminApiClient({ baseUrl: "/api/v1" });

    const settings = await api.notifications.getSettings();
    expect(settings).toMatchObject({ contract: "C10.NotificationSettingsResponse" });

    const updated = await api.notifications.updateSettings({
      settings: [
        { category: "info", channel: "telegram", enabled: true },
        { category: "info", channel: "email", enabled: false }
      ]
    });

    const infoTelegram = updated.settings.find(
      (setting) => setting.category === "info" && setting.channel === "telegram"
    );
    expect(infoTelegram?.enabled).toBe(true);

    // Изменение сохраняется: повторный запрос отражает новое состояние.
    const afterUpdate = await api.notifications.getSettings();
    const persisted = afterUpdate.settings.find(
      (setting) => setting.category === "info" && setting.channel === "telegram"
    );
    expect(persisted?.enabled).toBe(true);
  });
});
