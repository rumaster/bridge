import { Injectable } from "@nestjs/common";

import { CommunicationCoreLoadProbeService } from "../communication-core/communication-core-m5.service";
import { HealthService } from "./health.service";

@Injectable()
export class MetricsService {
  constructor(
    private readonly healthService: HealthService,
    private readonly communicationCoreLoadProbe: CommunicationCoreLoadProbeService,
  ) {}

  renderPrometheus(): string {
    const facadeMetrics = this.healthService
      .getFacadeStatuses()
      .map((facade) => `bridge_backend_facade_mock{facade="${facade.name}"} 1`)
      .join("\n");
    const coreSignals = this.communicationCoreLoadProbe.getSignals();
    const lastProbe = coreSignals.lastIngressProbe;

    return [
      "# HELP bridge_backend_up Backend process availability.",
      "# TYPE bridge_backend_up gauge",
      "bridge_backend_up 1",
      "# HELP bridge_backend_facade_mock Facade runs in M0 mock mode.",
      "# TYPE bridge_backend_facade_mock gauge",
      facadeMetrics,
      "# HELP bridge_backend_communication_core_ingress_total Communication Core ingress messages by result.",
      "# TYPE bridge_backend_communication_core_ingress_total counter",
      `bridge_backend_communication_core_ingress_total{result="accepted"} ${coreSignals.ingressAccepted}`,
      `bridge_backend_communication_core_ingress_total{result="duplicate"} ${coreSignals.ingressDuplicates}`,
      `bridge_backend_communication_core_ingress_total{result="failed"} ${coreSignals.ingressFailed}`,
      `bridge_backend_communication_core_ingress_total{result="all"} ${coreSignals.ingressTotal}`,
      "# HELP bridge_backend_communication_core_ingress_latency_ms Communication Core ingress latency in milliseconds.",
      "# TYPE bridge_backend_communication_core_ingress_latency_ms gauge",
      `bridge_backend_communication_core_ingress_latency_ms{quantile="p95"} ${coreSignals.ingressLatencyP95Ms}`,
      `bridge_backend_communication_core_ingress_latency_ms{quantile="max"} ${coreSignals.ingressLatencyMaxMs}`,
      "# HELP bridge_backend_communication_core_load_probe_last Last Communication Core ingress load-probe summary.",
      "# TYPE bridge_backend_communication_core_load_probe_last gauge",
      `bridge_backend_communication_core_load_probe_last{field="total"} ${lastProbe?.total ?? 0}`,
      `bridge_backend_communication_core_load_probe_last{field="accepted"} ${lastProbe?.accepted ?? 0}`,
      `bridge_backend_communication_core_load_probe_last{field="failed"} ${lastProbe?.failed ?? 0}`,
      `bridge_backend_communication_core_load_probe_last{field="throughput_per_second"} ${lastProbe?.throughput_per_second ?? 0}`,
      "",
    ].join("\n");
  }
}
