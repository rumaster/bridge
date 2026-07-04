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

import {
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
  constructor(private readonly messaging: InternalMessagingService) {}

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
}
