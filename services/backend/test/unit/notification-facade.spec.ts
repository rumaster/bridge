import { NotificationFacade } from "../../src/modules/notification-facade/notification-facade.facade";
import type {
  NotificationListFacadeResponse,
} from "../../src/modules/notification-facade/notification-facade.facade";

const fixedNow = () => "2026-07-02T16:31:00.000Z";

describe("NotificationFacade", () => {
  it("passes through a successful notification list response", async () => {
    const facade = new NotificationFacade();
    const response: NotificationListFacadeResponse = {
      contract: "C10.ListNotificationsResponse",
      version: "1.0.0",
      request_id: "req-notifications-list-1",
      organization_id: "org-1",
      recipient_user_id: "manager-1",
      degraded: false,
      fallback_reason: null,
      items: [],
      page: {
        limit: 50,
        next_cursor: null,
      },
    };

    await expect(
      facade.listNotifications(
        {
          request_id: "req-notifications-list-1",
          organization_id: "org-1",
          user_id: "manager-1",
        },
        {
          call: async () => response,
          now: fixedNow,
        },
      ),
    ).resolves.toBe(response);
  });

  it("returns controlled fallback when Notification has no callable client", async () => {
    const facade = new NotificationFacade();

    await expect(
      facade.getNotificationSettings(
        {
          request_id: "req-notification-settings-1",
          organization_id: "org-1",
          user_id: "manager-1",
        },
        { now: fixedNow },
      ),
    ).resolves.toMatchObject({
      contract: "C10.NotificationSettingsResponse",
      degraded: true,
      fallback_reason: "unavailable",
      organization_id: "org-1",
      user_id: "manager-1",
      settings: [],
    });
  });

  it("returns controlled timeout fallback for read acknowledgements", async () => {
    const facade = new NotificationFacade();

    await expect(
      facade.markNotificationRead(
        {
          request_id: "req-notification-read-1",
          organization_id: "org-1",
          user_id: "manager-1",
          notification_id: "notification-1",
        },
        {
          call: () => new Promise(() => undefined),
          timeoutMs: 1,
          now: fixedNow,
        },
      ),
    ).resolves.toMatchObject({
      contract: "C10.MarkNotificationReadResponse",
      degraded: true,
      fallback_reason: "timeout",
      organization_id: "org-1",
      notification: {
        id: "notification-1",
        status: "read",
        read_at: "2026-07-02T16:31:00.000Z",
      },
    });
  });
});
