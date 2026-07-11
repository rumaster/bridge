/**
 * Внутренние S2S-маршруты каналов (Этапы T2/T3,
 * docs/plan/telegram-channel-production.md).
 *
 * integration-platform (SVC-INT) не имеет прямого доступа к БД (ТЗ §22.3), но:
 *  - при исходящей доставке (T2) должен получить токен бота **той организации**,
 *    чей ответ доставляется — `GET /internal/channels/secret`;
 *  - для входящего драйвера (T3) должен знать список подключённых telegram-каналов
 *    и их организации, чтобы поднять поллер и смаппить апдейт бота на организацию —
 *    `GET /internal/channels?channel_type=telegram` (БЕЗ токена; токен берётся
 *    отдельным secret-эндпоинтом).
 *
 * Как и остальные `/internal/*` (см. bootstrap.ts), маршруты исключены из префикса
 * `api`/версии и предназначены только для доверенной внутренней сети — токен не
 * выходит наружу и не попадает в конверт C2.
 */

import { Controller, Get, NotFoundException, Query, Version, VERSION_NEUTRAL } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";

import {
  IntegrationGatewayFacade,
  type ActiveChannelSummary,
  type ChannelType,
} from "./integration-gateway.facade";

const CHANNEL_TYPES = new Set<ChannelType>([
  "web_chat",
  "telegram",
  "email",
  "sms",
  "vk",
  "max",
  "whatsapp",
]);

@ApiExcludeController()
@Controller("internal/channels")
export class InternalChannelSecretController {
  constructor(private readonly integrationGateway: IntegrationGatewayFacade) {}

  /**
   * Список активных каналов заданного типа по всем организациям (T3, без токена).
   * Входящий драйвер SVC-INT наполняет из него реестр ботов для поллинга.
   * Неизвестный/отсутствующий тип → пустой список (не ошибка).
   */
  @Get()
  @Version(VERSION_NEUTRAL)
  async listChannels(
    @Query("channel_type") channelType?: string,
  ): Promise<ActiveChannelSummary[]> {
    if (!channelType || !CHANNEL_TYPES.has(channelType as ChannelType)) {
      return [];
    }

    return this.integrationGateway.listActiveChannelsByType(channelType as ChannelType);
  }

  @Get("secret")
  @Version(VERSION_NEUTRAL)
  async getChannelSecret(
    @Query("organization_id") organizationId?: string,
    @Query("channel_type") channelType?: string,
  ): Promise<{ token: string }> {
    if (!organizationId || !channelType || !CHANNEL_TYPES.has(channelType as ChannelType)) {
      throw channelSecretNotFound();
    }

    const token = await this.integrationGateway.resolveChannelDeliveryToken(
      organizationId,
      channelType as ChannelType,
    );
    if (!token) {
      throw channelSecretNotFound();
    }

    return { token };
  }
}

function channelSecretNotFound(): NotFoundException {
  return new NotFoundException({
    code: "CHANNEL_SECRET_NOT_FOUND",
    description: "No connected channel secret was found for the requested organization and type.",
    humanMessage: "Секрет канала не найден.",
  });
}
