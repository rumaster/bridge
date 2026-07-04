import { BroadcastFacade } from "../../src/modules/broadcast-facade/broadcast-facade.facade";
import type {
  BroadcastCreateFacadeResponse,
} from "../../src/modules/broadcast-facade/broadcast-facade.facade";

const fixedNow = () => "2026-07-02T16:30:00.000Z";

describe("BroadcastFacade", () => {
  it("passes through a successful broadcast create response", async () => {
    const facade = new BroadcastFacade();
    const response: BroadcastCreateFacadeResponse = {
      contract: "C8.CreateBroadcastResponse",
      version: "1.0.0",
      request_id: "req-broadcast-create-1",
      organization_id: "org-1",
      broadcast: {
        id: "broadcast-1",
        organization_id: "org-1",
        name: "Июльская рассылка",
        status: "draft",
        template: { type: "text", body: "Здравствуйте" },
        filter: { mode: "all" },
        schedule: { mode: "manual" },
        rate_limit: { messages_per_minute: 120 },
        created_by: "manager-1",
        created_at: "2026-07-02T16:30:00.000Z",
        updated_at: "2026-07-02T16:30:00.000Z",
      },
    };

    await expect(
      facade.createBroadcast(
        {
          request_id: "req-broadcast-create-1",
          organization_id: "org-1",
          created_by: "manager-1",
          name: "Июльская рассылка",
        },
        {
          call: async () => response,
          now: fixedNow,
        },
      ),
    ).resolves.toBe(response);
  });

  it("returns controlled degraded fallback when Broadcast has no callable client", async () => {
    const facade = new BroadcastFacade();

    await expect(
      facade.startBroadcast(
        {
          request_id: "req-broadcast-start-1",
          organization_id: "org-1",
          broadcast_id: "broadcast-1",
          started_by: "manager-1",
        },
        { now: fixedNow },
      ),
    ).resolves.toMatchObject({
      contract: "C8.StartBroadcastResponse",
      degraded: true,
      fallback_reason: "unavailable",
      broadcast: {
        id: "broadcast-1",
        status: "failed",
      },
      core_delivery_draft: null,
      created_at: "2026-07-02T16:30:00.000Z",
    });
  });

  it("returns controlled timeout fallback for stats calls", async () => {
    const facade = new BroadcastFacade();

    await expect(
      facade.getBroadcastStats(
        {
          request_id: "req-broadcast-stats-1",
          organization_id: "org-1",
          broadcast_id: "broadcast-1",
        },
        {
          call: () => new Promise(() => undefined),
          timeoutMs: 1,
          now: fixedNow,
        },
      ),
    ).resolves.toMatchObject({
      contract: "C8.BroadcastStatsResponse",
      degraded: true,
      fallback_reason: "timeout",
      broadcast_id: "broadcast-1",
      status: "failed",
      stats: {
        prepared: 0,
        sent: 0,
        delivered: 0,
        failed: 0,
        updated_at: "2026-07-02T16:30:00.000Z",
      },
    });
  });

  it("returns controlled unavailable fallback when the broadcast bulkhead is full", async () => {
    const facade = new BroadcastFacade({
      bulkhead: {
        maxConcurrent: 1,
        maxQueue: 0,
      },
    });
    const pending = facade.startBroadcast(
      {
        request_id: "req-broadcast-start-pending",
        organization_id: "org-1",
        broadcast_id: "broadcast-1",
        started_by: "manager-1",
      },
      {
        call: () => new Promise(() => undefined),
        timeoutMs: 50,
        now: fixedNow,
      },
    );
    const rejectedCall = jest.fn(async () => {
      throw new Error("bulkhead should reject before the upstream call");
    });

    await expect(
      facade.createBroadcast(
        {
          request_id: "req-broadcast-create-bulkhead",
          organization_id: "org-1",
          created_by: "manager-1",
          name: "Bulkhead fallback",
        },
        {
          call: rejectedCall,
          now: fixedNow,
        },
      ),
    ).resolves.toMatchObject({
      contract: "C8.CreateBroadcastResponse",
      degraded: true,
      fallback_reason: "unavailable",
      broadcast: {
        name: "Bulkhead fallback",
        status: "failed",
      },
    });
    expect(rejectedCall).not.toHaveBeenCalled();

    await pending;
  });
});
