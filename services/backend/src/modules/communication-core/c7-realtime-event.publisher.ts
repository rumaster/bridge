import { Injectable, Logger } from "@nestjs/common";

import { RedisInfrastructureService } from "../../common/redis/redis.service";
import type { MessageResponseDto } from "./communication-core.dto";

export const DEFAULT_C7_REALTIME_STREAM = "bridge:c7:events";
const C7_CONTRACT = "C7.WebSocketEvent";
const C7_VERSION = "1.0.0";

export interface MessageStatusChangedEventInput {
  eventId: string;
  messageId: string;
  organizationId: string;
  sequenceNumber: number;
  status: string;
  occurredAt?: string;
}

@Injectable()
export class C7RealtimeEventPublisher {
  private readonly logger = new Logger(C7RealtimeEventPublisher.name);
  private warnedNoRedis = false;

  constructor(private readonly redis: RedisInfrastructureService) {}

  async publishMessageCreated(message: MessageResponseDto): Promise<void> {
    await this.publish("message.created", {
      eventId: `message.created:${message.id}`,
      organizationId: message.organizationId,
      sequenceNumber: message.sequenceNumber,
      payload: { message },
      occurredAt: message.createdAt,
    });
  }

  async publishMessageStatusChanged(input: MessageStatusChangedEventInput): Promise<void> {
    await this.publish("message.status_changed", {
      eventId: input.eventId,
      organizationId: input.organizationId,
      sequenceNumber: input.sequenceNumber,
      payload: {
        message_id: input.messageId,
        status: input.status,
      },
      occurredAt: input.occurredAt,
    });
  }

  private async publish(
    type: "message.created" | "message.status_changed",
    input: {
      eventId: string;
      organizationId: string;
      sequenceNumber: number;
      payload: unknown;
      occurredAt?: string;
    },
  ): Promise<void> {
    if (!this.redis.isConfigured()) {
      // Видимая деградация вместо тихого no-op (W3, WG-8): realtime C7 отключён —
      // сообщения не будут доставляться менеджеру/посетителю по WS в реальном
      // времени (лента подтянет их только через REST). Логируем один раз, чтобы не
      // спамить; публикация остаётся best-effort и не роняет создание сообщения.
      if (!this.warnedNoRedis) {
        this.warnedNoRedis = true;
        this.logger.warn(
          "C7 realtime disabled: REDIS_URL is not configured — realtime WS events " +
            "(message.created/status_changed) will NOT be published",
        );
      }
      return;
    }

    const event = {
      contract: C7_CONTRACT,
      version: C7_VERSION,
      event: type,
      event_id: input.eventId,
      organization_id: input.organizationId,
      sequence_number: input.sequenceNumber,
      payload: input.payload,
      occurred_at: input.occurredAt ?? new Date().toISOString(),
    };

    try {
      await this.redis.publishStream(realtimeStreamName(), {
        event: JSON.stringify(event),
        type,
      });
    } catch (error) {
      this.logger.warn(
        `C7 Redis publish failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function realtimeStreamName(): string {
  const value = process.env.C7_REALTIME_STREAM?.trim();
  return value || DEFAULT_C7_REALTIME_STREAM;
}
