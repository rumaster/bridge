import { Injectable } from "@nestjs/common";

import { HealthService } from "./health.service";

@Injectable()
export class MetricsService {
  constructor(private readonly healthService: HealthService) {}

  renderPrometheus(): string {
    const facadeMetrics = this.healthService
      .getFacadeStatuses()
      .map((facade) => `bridge_backend_facade_mock{facade="${facade.name}"} 1`)
      .join("\n");

    return [
      "# HELP bridge_backend_up Backend process availability.",
      "# TYPE bridge_backend_up gauge",
      "bridge_backend_up 1",
      "# HELP bridge_backend_facade_mock Facade runs in M0 mock mode.",
      "# TYPE bridge_backend_facade_mock gauge",
      facadeMetrics,
      "",
    ].join("\n");
  }
}
