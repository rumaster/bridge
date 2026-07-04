/**
 * Внутренние service-to-service маршруты messaging-пути (issue #189, п. 1–2).
 *
 * Эти эндпоинты вызывает integration-platform (см. `CORE_INGRESS_URL`,
 * `INTEGRATION_EGRESS_URL` в docker-compose): они не проходят через версионирование
 * URI и глобальный префикс `api`, поэтому итоговые пути —
 * `/internal/ingress/messages`, `/internal/egress/messages`,
 * `/internal/delivery/attempts` (см. исключения в `bootstrap.ts`).
 */

import { Body, Controller, HttpCode, Post, Version, VERSION_NEUTRAL } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";

import type { BroadcastDeliveryDraft, EdgeTunnelMessage } from "./communication-core-m4.dto";
import { EdgeIntakeCoordinatorService } from "./edge-intake.service";
import {
  BroadcastDeliveryResult,
  DeliveryAttemptResult,
  EgressHandoffResult,
  IngressAcceptResult,
  InternalMessagingService,
} from "./internal-messaging.service";
import type {
  DeliveryAttemptBody,
  EgressRequestBody,
  IngressEnvelope,
} from "./internal-messaging.dto";

@ApiExcludeController()
@Controller("internal")
export class InternalMessagingController {
  constructor(
    private readonly messaging: InternalMessagingService,
    private readonly edgeIntake: EdgeIntakeCoordinatorService,
  ) {}

  @Post("ingress/messages")
  @Version(VERSION_NEUTRAL)
  @HttpCode(202)
  acceptIngress(@Body() body: IngressEnvelope): Promise<IngressAcceptResult> {
    return this.messaging.acceptIngress(body);
  }

  @Post("egress/messages")
  @Version(VERSION_NEUTRAL)
  @HttpCode(202)
  handoffEgress(@Body() body: EgressRequestBody): Promise<EgressHandoffResult> {
    return this.messaging.handoffEgress(body);
  }

  @Post("delivery/attempts")
  @Version(VERSION_NEUTRAL)
  @HttpCode(202)
  recordDeliveryAttempt(@Body() body: DeliveryAttemptBody): Promise<DeliveryAttemptResult> {
    return this.messaging.recordDeliveryAttempt(body);
  }

  @Post("edge/tunnel/messages")
  @Version(VERSION_NEUTRAL)
  @HttpCode(202)
  acceptEdgeTunnelMessage(@Body() body: EdgeTunnelMessage) {
    return this.edgeIntake.intake(body);
  }

  @Post("broadcast/deliveries")
  @Version(VERSION_NEUTRAL)
  @HttpCode(202)
  deliverBroadcast(@Body() body: BroadcastDeliveryDraft): Promise<BroadcastDeliveryResult> {
    return this.messaging.deliverBroadcast(body);
  }
}
