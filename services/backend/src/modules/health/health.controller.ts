import { Controller, Get, Header, Version } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from "@nestjs/swagger";

import { HealthResponseDto } from "./health.dto";
import { HealthService } from "./health.service";
import { MetricsService } from "./metrics.service";

@ApiTags("health")
@Controller()
export class HealthController {
  constructor(
    private readonly healthService: HealthService,
    private readonly metricsService: MetricsService,
  ) {}

  @Get("health")
  @Version("1")
  @ApiOperation({ summary: "Backend health check" })
  @ApiOkResponse({ type: HealthResponseDto })
  getHealth(): HealthResponseDto {
    return this.healthService.getHealth();
  }

  @Get("metrics")
  @Header("Content-Type", "text/plain; version=0.0.4")
  @Version("1")
  @ApiOperation({ summary: "Backend metrics skeleton" })
  @ApiOkResponse({ description: "Prometheus text exposition" })
  @ApiProduces("text/plain")
  getMetrics(): string {
    return this.metricsService.renderPrometheus();
  }
}
