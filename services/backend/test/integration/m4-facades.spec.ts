import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../../src/app.module";
import { configureBackendApp } from "../../src/bootstrap";
import { PgDatabase } from "../../src/common/database/database.service";
import { BROADCAST_UPSTREAM_CLIENT } from "../../src/modules/broadcast-facade/broadcast-facade.upstream";
import type {
  BroadcastCreateFacadeRequest,
  BroadcastStartFacadeRequest,
  BroadcastStatsFacadeRequest,
} from "../../src/modules/broadcast-facade/broadcast-facade.facade";
import { NOTIFICATION_UPSTREAM_CLIENT } from "../../src/modules/notification-facade/notification-facade.upstream";
import type {
  NotificationListFacadeRequest,
  NotificationReadFacadeRequest,
  NotificationSettingFacade,
  NotificationSettingsUpdateFacadeRequest,
} from "../../src/modules/notification-facade/notification-facade.facade";

const ORG_A = "30000000-0000-4000-8000-000000000101";
const ORG_B = "30000000-0000-4000-8000-000000000102";
const MANAGER_A = "30000000-0000-4000-8000-000000000202";
const MANAGER_TOKEN = "brs_m4_manager";
const FIXED_NOW = "2026-07-04T09:00:00.000Z";

describe("SVC-API M4 Broadcast/Notification facades (C8/C10)", () => {
  let app: INestApplication;
  let broadcastMock: ReturnType<typeof createBroadcastContractMock>;
  let notificationMock: ReturnType<typeof createNotificationContractMock>;

  beforeAll(async () => {
    broadcastMock = createBroadcastContractMock();
    notificationMock = createNotificationContractMock();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PgDatabase)
      .useValue(createAuthDatabaseStub())
      .overrideProvider(BROADCAST_UPSTREAM_CLIENT)
      .useValue(broadcastMock)
      .overrideProvider(NOTIFICATION_UPSTREAM_CLIENT)
      .useValue(notificationMock)
      .compile();

    app = moduleRef.createNestApplication();
    configureBackendApp(app, { installSwaggerUi: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("creates broadcasts idempotently and replays the cached Backend response", async () => {
    const payload = validBroadcastPayload("Июльская рассылка");

    const first = await request(app.getHttpServer())
      .post("/api/v1/broadcasts")
      .set("authorization", `Bearer ${MANAGER_TOKEN}`)
      .set("x-organization-id", ORG_A)
      .set("x-request-id", "req-broadcast-create-1")
      .set("idempotency-key", "idem-broadcast-create-1")
      .send(payload)
      .expect(201);

    expect(first.body).toMatchObject({
      contract: "C8.CreateBroadcastResponse",
      request_id: "req-broadcast-create-1",
      organization_id: ORG_A,
      broadcast: {
        name: "Июльская рассылка",
        status: "draft",
      },
    });

    const second = await request(app.getHttpServer())
      .post("/api/v1/broadcasts")
      .set("authorization", `Bearer ${MANAGER_TOKEN}`)
      .set("x-organization-id", ORG_A)
      .set("x-request-id", "req-broadcast-create-2")
      .set("idempotency-key", "idem-broadcast-create-1")
      .send(payload)
      .expect(201);

    expect(second.headers["x-idempotency-replayed"]).toBe("true");
    expect(second.body.request_id).toBe("req-broadcast-create-1");
    expect(broadcastMock.createBroadcast).toHaveBeenCalledTimes(1);
  });

  it("starts a broadcast, exposes stats, and degrades when BCAST is unavailable", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/broadcasts/broadcast-m4-1:start")
      .set("authorization", `Bearer ${MANAGER_TOKEN}`)
      .set("x-organization-id", ORG_A)
      .set("x-request-id", "req-broadcast-start-1")
      .send({ mode: "immediate" })
      .expect(200)
      .expect(({ body }) => {
        expect(body.contract).toBe("C8.StartBroadcastResponse");
        expect(body.degraded).toBe(false);
        expect(body.broadcast.status).toBe("running");
        expect(body.core_delivery_draft.delivery_path).toBe("C1/C2");
      });

    await request(app.getHttpServer())
      .get("/api/v1/broadcasts/broadcast-m4-1/stats")
      .set("authorization", `Bearer ${MANAGER_TOKEN}`)
      .set("x-organization-id", ORG_A)
      .set("x-request-id", "req-broadcast-stats-1")
      .expect(200)
      .expect(({ body }) => {
        expect(body.contract).toBe("C8.BroadcastStatsResponse");
        expect(body.stats.sent).toBe(4);
      });

    await request(app.getHttpServer())
      .get("/api/v1/broadcasts/broadcast-down/stats")
      .set("authorization", `Bearer ${MANAGER_TOKEN}`)
      .set("x-organization-id", ORG_A)
      .set("x-request-id", "req-broadcast-stats-down")
      .expect(200)
      .expect(({ body }) => {
        expect(body.degraded).toBe(true);
        expect(body.fallback_reason).toBe("unavailable");
        expect(body.status).toBe("failed");
      });
  });

  it("rejects invalid broadcast DTOs before they reach BCAST", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/broadcasts")
      .set("authorization", `Bearer ${MANAGER_TOKEN}`)
      .set("x-organization-id", ORG_A)
      .send({ name: "invalid" })
      .expect(400)
      .expect(({ body }) => {
        expect(body.code).toBe("VALIDATION_FAILED");
      });
  });

  it("lists, reads and updates notifications through NOTIF", async () => {
    const list = await request(app.getHttpServer())
      .get("/api/v1/notifications")
      .set("authorization", `Bearer ${MANAGER_TOKEN}`)
      .set("x-organization-id", ORG_A)
      .set("x-request-id", "req-notifications-list-1")
      .expect(200);

    expect(list.body).toMatchObject({
      contract: "C10.ListNotificationsResponse",
      organization_id: ORG_A,
      recipient_user_id: MANAGER_A,
    });
    expect(list.body.items).toHaveLength(1);

    await request(app.getHttpServer())
      .post(`/api/v1/notifications/${list.body.items[0].id}:read`)
      .set("authorization", `Bearer ${MANAGER_TOKEN}`)
      .set("x-organization-id", ORG_A)
      .set("x-request-id", "req-notification-read-1")
      .send({})
      .expect(200)
      .expect(({ body }) => {
        expect(body.contract).toBe("C10.MarkNotificationReadResponse");
        expect(body.notification.status).toBe("read");
      });

    await request(app.getHttpServer())
      .put("/api/v1/notifications/settings")
      .set("authorization", `Bearer ${MANAGER_TOKEN}`)
      .set("x-organization-id", ORG_A)
      .set("x-request-id", "req-notification-settings-put-1")
      .send({
        settings: [
          { category: "critical", channel: "web", enabled: true },
          { category: "critical", channel: "telegram", enabled: true },
        ],
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body.contract).toBe("C10.NotificationSettingsResponse");
        expect(body.settings).toHaveLength(2);
      });

    await request(app.getHttpServer())
      .get("/api/v1/notifications/settings")
      .set("authorization", `Bearer ${MANAGER_TOKEN}`)
      .set("x-organization-id", ORG_A)
      .expect(200)
      .expect(({ body }) => {
        expect(body.settings.map((item: { channel: string }) => item.channel).sort()).toEqual([
          "telegram",
          "web",
        ]);
      });
  });

  it("validates and isolates notification requests before NOTIF", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/notifications?category=unknown")
      .set("authorization", `Bearer ${MANAGER_TOKEN}`)
      .set("x-organization-id", ORG_A)
      .expect(400)
      .expect(({ body }) => {
        expect(body.code).toBe("VALIDATION_FAILED");
      });

    await request(app.getHttpServer())
      .get("/api/v1/notifications")
      .set("authorization", `Bearer ${MANAGER_TOKEN}`)
      .set("x-organization-id", ORG_B)
      .expect(403)
      .expect(({ body }) => {
        expect(body.code).toBe("TENANT_FORBIDDEN");
      });
  });

  it("degrades notification list calls without crashing the Backend core", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/notifications?category=admin")
      .set("authorization", `Bearer ${MANAGER_TOKEN}`)
      .set("x-organization-id", ORG_A)
      .set("x-request-id", "req-notifications-list-down")
      .expect(200)
      .expect(({ body }) => {
        expect(body.contract).toBe("C10.ListNotificationsResponse");
        expect(body.degraded).toBe(true);
        expect(body.fallback_reason).toBe("unavailable");
        expect(body.items).toEqual([]);
      });
  });
});

function createBroadcastContractMock() {
  const broadcasts = new Map<string, ReturnType<typeof createBroadcastCampaign>>();

  return {
    listBroadcasts: jest.fn(async (request: { request_id: string; organization_id: string }) => {
      const items = [...broadcasts.values()].filter(
        (broadcast) => broadcast.organization_id === request.organization_id,
      );

      return {
        contract: "C8.ListBroadcastsResponse" as const,
        version: "1.0.0" as const,
        request_id: request.request_id,
        organization_id: request.organization_id,
        items,
        page: {
          limit: 50,
          offset: 0,
          total: items.length,
        },
      };
    }),
    createBroadcast: jest.fn(async (request: BroadcastCreateFacadeRequest) => {
      const broadcast = createBroadcastCampaign({
        id: `broadcast-${broadcasts.size + 1}`,
        name: request.name,
        organizationId: request.organization_id,
        status: request.schedule?.mode === "scheduled" ? "scheduled" : "draft",
        userId: request.created_by,
      });
      broadcasts.set(broadcast.id, broadcast);

      return {
        contract: "C8.CreateBroadcastResponse" as const,
        version: "1.0.0" as const,
        request_id: request.request_id,
        organization_id: request.organization_id,
        broadcast,
      };
    }),
    startBroadcast: jest.fn(async (request: BroadcastStartFacadeRequest) => {
      const existing =
        broadcasts.get(request.broadcast_id) ??
        createBroadcastCampaign({
          id: request.broadcast_id,
          name: "Started from integration",
          organizationId: request.organization_id,
          status: "draft",
          userId: request.started_by,
        });
      const broadcast = {
        ...existing,
        status: request.mode === "scheduled" ? "scheduled" as const : "running" as const,
        updated_at: FIXED_NOW,
      };
      broadcasts.set(request.broadcast_id, broadcast);

      return {
        contract: "C8.StartBroadcastResponse" as const,
        version: "1.0.0" as const,
        request_id: request.request_id,
        organization_id: request.organization_id,
        broadcast,
        degraded: false,
        fallback_reason: null,
        core_delivery_draft: {
          contract: "C8.BroadcastCoreDeliveryDraft",
          version: "1.0.0",
          broadcast_id: request.broadcast_id,
          organization_id: request.organization_id,
          delivery_path: "C1/C2",
          core_contracts: ["C1", "C2"],
        },
        state_changed_event: {
          event: "broadcast.state_changed",
          broadcast_id: request.broadcast_id,
          status: broadcast.status,
        },
        created_at: FIXED_NOW,
      };
    }),
    getBroadcastStats: jest.fn(async (request: BroadcastStatsFacadeRequest) => {
      if (request.broadcast_id === "broadcast-down") {
        throw new Error("SVC-BCAST unavailable");
      }

      return {
        contract: "C8.BroadcastStatsResponse" as const,
        version: "1.0.0" as const,
        request_id: request.request_id,
        organization_id: request.organization_id,
        broadcast_id: request.broadcast_id,
        status: "running" as const,
        stats: {
          prepared: 10,
          sent: 4,
          delivered: 3,
          failed: 1,
          updated_at: FIXED_NOW,
        },
      };
    }),
  };
}

function createNotificationContractMock() {
  const notification = createNotification("notification-m4-1", "critical", "new");
  const notifications = new Map([[notification.id, notification]]);
  let settings: NotificationSettingFacade[] = [
    { category: "critical" as const, channel: "web" as const, enabled: true },
    { category: "critical" as const, channel: "telegram" as const, enabled: true },
  ];

  return {
    listNotifications: jest.fn(async (request: NotificationListFacadeRequest) => {
      if (request.category === "admin") {
        throw new Error("SVC-NOTIF unavailable");
      }

      const items = [...notifications.values()]
        .filter((item) => item.organization_id === request.organization_id)
        .filter((item) => item.recipient_user_id === request.user_id)
        .filter((item) => !request.status || item.status === request.status)
        .filter((item) => !request.category || item.category === request.category);

      return {
        contract: "C10.ListNotificationsResponse" as const,
        version: "1.0.0" as const,
        request_id: request.request_id,
        organization_id: request.organization_id,
        recipient_user_id: request.user_id,
        items,
        page: {
          limit: request.limit ?? 50,
          next_cursor: null,
        },
      };
    }),
    markNotificationRead: jest.fn(async (request: NotificationReadFacadeRequest) => {
      const existing = notifications.get(request.notification_id);
      const updated = {
        ...(existing ?? createNotification(request.notification_id, "info", "new")),
        status: "read" as const,
        read_at: FIXED_NOW,
      };
      notifications.set(updated.id, updated);

      return {
        contract: "C10.MarkNotificationReadResponse" as const,
        version: "1.0.0" as const,
        request_id: request.request_id,
        organization_id: request.organization_id,
        notification: updated,
      };
    }),
    getNotificationSettings: jest.fn(async (request: { request_id: string; organization_id: string; user_id: string }) => ({
      contract: "C10.NotificationSettingsResponse" as const,
      version: "1.0.0" as const,
      request_id: request.request_id,
      organization_id: request.organization_id,
      user_id: request.user_id,
      settings,
    })),
    updateNotificationSettings: jest.fn(async (request: NotificationSettingsUpdateFacadeRequest) => {
      settings = request.settings;

      return {
        contract: "C10.NotificationSettingsResponse" as const,
        version: "1.0.0" as const,
        request_id: request.request_id,
        organization_id: request.organization_id,
        user_id: request.user_id,
        settings,
      };
    }),
  };
}

function validBroadcastPayload(name: string) {
  return {
    name,
    template: {
      type: "text",
      body: "Здравствуйте, {{client.name}}",
      variables: ["client.name"],
    },
    filter: {
      mode: "all",
      channels: ["web_chat"],
      tags: [],
      segment_ids: [],
      criteria: {},
    },
    schedule: {
      mode: "manual",
    },
    rate_limit: {
      messages_per_minute: 120,
      strategy: "fixed",
    },
  };
}

function createBroadcastCampaign({
  id,
  name,
  organizationId,
  status,
  userId,
}: {
  id: string;
  name: string;
  organizationId: string;
  status: "draft" | "scheduled" | "running";
  userId: string;
}) {
  return {
    id,
    organization_id: organizationId,
    name,
    status,
    template: {
      type: "text",
      body: "Здравствуйте, {{client.name}}",
      variables: ["client.name"],
    },
    filter: {
      mode: "all",
      channels: ["web_chat"],
      tags: [],
      segment_ids: [],
      criteria: {},
    },
    schedule: {
      mode: "manual",
    },
    rate_limit: {
      messages_per_minute: 120,
      strategy: "fixed",
    },
    created_by: userId,
    created_at: FIXED_NOW,
    updated_at: FIXED_NOW,
  };
}

function createNotification(
  id: string,
  category: "info" | "critical",
  status: "new" | "read",
) {
  return {
    contract: "C10.Notification" as const,
    version: "1.0.0" as const,
    id,
    organization_id: ORG_A,
    recipient_user_id: MANAGER_A,
    category,
    title: "Priority message",
    body: "Client sent a priority message.",
    payload: {
      source: "integration-test",
    },
    status,
    channels: ["web" as const, "telegram" as const],
    created_at: FIXED_NOW,
    read_at: status === "read" ? FIXED_NOW : null,
    dedupe_key: `dedupe:${id}`,
  };
}

function createAuthDatabaseStub(): Pick<PgDatabase, "withTenant"> {
  return {
    async withTenant(_organizationId, callback) {
      return callback({
        async query() {
          return {
            rowCount: 1,
            rows: [
              {
                display_name: "M4 Manager",
                expires_at: new Date("2099-01-01T00:00:00.000Z"),
                id: "30000000-0000-4000-8000-000000000902",
                issued_at: new Date(FIXED_NOW),
                organization_id: ORG_A,
                organization_name: "Tenant M4",
                organization_status: "active",
                revoked_at: null,
                role_bindings: [{ role: "manager", organizationId: ORG_A }],
                roles: ["manager"],
                telegram_username: "m4_manager",
                user_id: MANAGER_A,
                user_status: "active",
              },
            ],
          };
        },
      } as never);
    },
  };
}
