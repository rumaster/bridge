import {
  AdapterFailureCoordinator,
  CommunicationCoreLoadProbeService,
} from "../../src/modules/communication-core/communication-core-m5.service";
import { MESSAGE_STATUS } from "../../src/modules/communication-core/message-status";
import type { MessageStatus } from "../../src/modules/communication-core/message-status";

describe("Communication Core M5 services", () => {
  it("retries adapter failures and marks the final delivery as degraded", async () => {
    const coordinator = new AdapterFailureCoordinator();
    const recorded: Array<{ attemptNo: number; final: boolean; status: MessageStatus }> = [];
    let adapterCalls = 0;

    const result = await coordinator.deliver({
      maxAttempts: 2,
      timeoutMs: 50,
      callAdapter: async () => {
        adapterCalls += 1;
        return { accepted: false, error: "HTTP 503", forwarded: false };
      },
      recordAttempt: async ({ attemptNo, final, status, error }) => {
        recorded.push({ attemptNo, final, status });

        return {
          attempt_no: attemptNo,
          status,
          error,
          messageStatus: final ? status : MESSAGE_STATUS.ROUTED,
        };
      },
    });

    expect(adapterCalls).toBe(2);
    expect(recorded).toEqual([
      { attemptNo: 1, final: false, status: "failed" },
      { attemptNo: 2, final: true, status: "failed" },
    ]);
    expect(result).toMatchObject({
      accepted: false,
      delivered: false,
      degraded: true,
      reason: "adapter_rejected",
      error: "HTTP 503",
      status: "failed",
      forwarded: false,
      attempt_count: 2,
    });
  });

  it("records ingress counters and exposes the last load-probe report", async () => {
    const loadProbe = new CommunicationCoreLoadProbeService();

    loadProbe.recordIngress({ accepted: true, duplicate: false }, 2);
    loadProbe.recordIngress({ accepted: true, duplicate: true }, 4);
    loadProbe.recordIngressFailure(6);

    await loadProbe.runIngressProbe({
      name: "unit-probe",
      messages: [1, 2, 3],
      concurrency: 2,
      task: async (message) => ({ accepted: message !== 3, duplicate: message === 2 }),
    });

    expect(loadProbe.getSignals()).toMatchObject({
      ingressTotal: 3,
      ingressAccepted: 2,
      ingressDuplicates: 1,
      ingressFailed: 1,
      ingressLatencyMaxMs: 6,
      lastIngressProbe: {
        name: "unit-probe",
        total: 3,
        accepted: 2,
        duplicates: 1,
        failed: 1,
        concurrency: 2,
      },
    });
  });
});
