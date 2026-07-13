/**
 * Внутренний messaging-путь production-сборки backend (issue #189, пункты 1–3).
 *
 * Реализует на исполняемом NestJS/TypeScript то, что раньше существовало только
 * в неисполняемых прототипах (`communication-core-m1`):
 *   - приём входящих сообщений `POST /internal/ingress/messages`
 *     (конверт C2.IngressMessage от integration-platform);
 *   - передачу исходящих сообщений `POST /internal/egress/messages`
 *     (конверт C2.EgressDelivery в integration-platform/адаптер канала);
 *   - фиксацию попыток доставки `POST /internal/delivery/attempts`
 *     (конверт C2.DeliveryAttempt — обратная нога доставки).
 *
 * Все операции идут через `PgDatabase.withTenant` (RLS по организации) и
 * валидируют переходы статуса портированной машиной состояний C1
 * (`message-status.ts`).
 */

import { randomUUID } from "node:crypto";

import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";

import { PgDatabase } from "../../common/database/database.service";
import type { Queryable } from "../../common/database/database.service";
import { resolveEdgeControlUrl } from "../../common/edge-control/edge-control-endpoint";
import { AuditService } from "../audit/audit.service";
import { C7RealtimeEventPublisher } from "./c7-realtime-event.publisher";
import { attachmentContentUrl } from "./communication-core.dto";
import {
  assertMessageStatusTransition,
  MESSAGE_DIRECTION,
  MESSAGE_STATUS,
} from "./message-status";
import {
  buildC2EgressDelivery,
  type CanonicalIngressMessage,
  normalizeDeliveryAttempt,
  normalizeEgressRequest,
  normalizeIngressEnvelope,
  uuidFromText,
} from "./internal-messaging.dto";
import type {
  C2EgressAttachment,
  C2EgressDelivery,
  DeliveryAttemptBody,
  EgressRequestBody,
  IngressEnvelope,
  NormalizedIngress,
} from "./internal-messaging.dto";
import {
  type BroadcastDeliveryDraft,
  normalizeBroadcastDeliveryDraft,
} from "./communication-core-m4.dto";
import {
  AdapterFailureCoordinator,
  type AdapterDeliveryOutcome,
  type AdapterFailureDeliveryResult,
  CommunicationCoreLoadProbeService,
} from "./communication-core-m5.service";
import type { MessageStatus } from "./message-status";

/**
 * Каналы с прямым realtime-подключением клиента (виджет по C7/WS, напр. Web Chat):
 * исходящее доставляется публикацией C7-события, внешнего egress-адаптера у канала
 * нет. Такие каналы исключаются из handoffEgress/SVC-INT — иначе получаем фантомный
 * `failed` (prod) или `delivered` (mock-fallback) от несуществующего адаптера
 * (WG-6, docs/plan/web-chat-channel-production.md, этап W1). Доставку подтверждает
 * WS-ack (routed -> delivered) на этапе W3.
 */
export const DIRECT_REALTIME_CHANNELS: ReadonlySet<string> = new Set(["web_chat"]);

export function isDirectRealtimeChannel(channel: string): boolean {
  return DIRECT_REALTIME_CHANNELS.has(channel);
}

interface EndpointRow {
  id: string;
  client_id: string;
  channel: string;
  external_id: string;
  metadata: Record<string, unknown> | null;
}

interface ConversationRow {
  id: string;
  client_id: string;
}

interface MessageRow {
  id: string;
  organization_id: string;
  conversation_id: string;
  endpoint_id: string;
  channel: string;
  direction: string;
  type: string;
  content: Record<string, unknown>;
  status: string;
  sequence_number: string;
}

interface DeliveryAttemptRow {
  attempt_no: number;
  status: MessageStatus;
  error: string | null;
}

interface BroadcastMessageRow {
  status: string;
}

export interface IngressAcceptResult {
  accepted: boolean;
  duplicate: boolean;
  message_id: string;
  idempotency_key: string;
  organization_id: string;
  client_id: string;
  conversation_id: string;
  endpoint_id: string;
  sequence_number: number;
  status: string;
  routed_to: string;
  received_at: string;
  routed_at: string;
}

export interface EgressHandoffResult {
  accepted: boolean;
  message_id: string;
  organization_id: string;
  conversation_id: string;
  endpoint_id: string;
  channel: string;
  status: string;
  adapter: string;
  attempt_no: number;
  forwarded: boolean;
  degraded: boolean;
  error: string | null;
  delivery: C2EgressDelivery;
  sent_at: string;
}

export interface DeliveryAttemptResult {
  accepted: boolean;
  message_id: string;
  organization_id: string;
  adapter: string;
  attempt_no: number;
  attempt_status: string;
  message_status: string;
  occurred_at: string;
}

export interface BroadcastDeliveryResult {
  duplicate: boolean;
  delivered: boolean;
  degraded: boolean;
  broadcast_id: string;
  message_id: string;
  conversation_id: string;
  endpoint_id: string;
  sequence_number: number;
  status: string;
  broadcast_message_status: string | null;
  error: string | null;
  forwarded: boolean;
  attempts: Array<{
    attempt_no: number;
    status: string;
    error: string | null;
  }>;
}

@Injectable()
export class InternalMessagingService {
  private readonly logger = new Logger(InternalMessagingService.name);

  constructor(
    private readonly database: PgDatabase,
    private readonly audit: AuditService,
    private readonly adapterFailures: AdapterFailureCoordinator,
    private readonly loadProbe: CommunicationCoreLoadProbeService,
    private readonly realtime: C7RealtimeEventPublisher,
  ) {}

  private now(): string {
    return new Date().toISOString();
  }

  /**
   * Принимает входящее сообщение (C2.IngressMessage), идемпотентно сохраняет его
   * в статусе `routed` и связывает с клиентом/endpoint-ом/диалогом. Порт
   * `acceptIngressMessage` + `recordInboundMessage` (Postgres-хранилище m1).
   */
  async acceptIngress(payload: IngressEnvelope | CanonicalIngressMessage): Promise<IngressAcceptResult> {
    const finish = this.loadProbe.startTimer();
    try {
      const ingress = normalizeIngressEnvelope(payload, () => this.now());
      // Валидируем переход received -> routed портированной машиной состояний C1
      // до записи: сообщение сохраняется сразу в статусе routed, т.к. в схеме нет
      // отдельных колонок routed_at/sent_at (см. миграцию m1_schema).
      assertMessageStatusTransition(MESSAGE_STATUS.RECEIVED, MESSAGE_STATUS.ROUTED);

      const result = await this.database.withTenant(ingress.organizationId, async (client) => {
        const existing = await this.findMessage(client, ingress.organizationId, ingress.message.id);
        if (existing) {
          return this.duplicateIngressResult(client, ingress, existing);
        }

        const endpoint = await this.resolveEndpoint(client, ingress);
        await this.lockEndpointPartition(client, ingress.organizationId, endpoint.id);

        const existingAfterLock = await this.findMessage(
          client,
          ingress.organizationId,
          ingress.message.id,
        );
        if (existingAfterLock) {
          return this.duplicateIngressResult(client, ingress, existingAfterLock);
        }

        const conversation = await this.resolveConversation(
          client,
          ingress.organizationId,
          endpoint.client_id,
          ingress.occurredAt,
          ingress.conversationId,
        );
        const sequenceNumber =
          ingress.message.sequenceNumber ??
          (await this.nextSequenceNumber(client, ingress.organizationId, endpoint.id));

        await client.query(
          `
            INSERT INTO messages (
              id,
              organization_id,
              conversation_id,
              endpoint_id,
              channel,
              direction,
              sender_type,
              sequence_number,
              type,
              content,
              status,
              created_at
            )
            VALUES ($1, $2, $3, $4, $5, 'inbound', 'client', $6, $7, $8::jsonb, 'routed', $9::timestamptz)
          `,
          [
            ingress.message.id,
            ingress.organizationId,
            conversation.id,
            endpoint.id,
            endpoint.channel,
            sequenceNumber,
            ingress.message.type,
            JSON.stringify(ingress.message.content),
            ingress.occurredAt,
          ],
        );

        // Вложения (§4.3): непрозрачный `storage_ref` из конверта сохраняется как
        // есть (ядро схему не парсит — резолвит Edge). ON CONFLICT DO NOTHING —
        // повторный приём того же письма (детерминированные id) не плодит дублей.
        for (const attachment of ingress.message.attachments) {
          await client.query(
            `
              INSERT INTO attachments (
                id, organization_id, message_id, kind, storage_ref, mime, size, metadata
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
              ON CONFLICT (id) DO NOTHING
            `,
            [
              attachment.id,
              ingress.organizationId,
              ingress.message.id,
              attachment.kind,
              attachment.storageRef,
              attachment.mime,
              attachment.size,
              JSON.stringify(attachment.metadata ?? {}),
            ],
          );
        }

        await client.query(
          `
            UPDATE conversations
            SET last_message_at = GREATEST($3::timestamptz, COALESCE(last_message_at, $3::timestamptz)),
                updated_at = now()
            WHERE organization_id = $1 AND id = $2
          `,
          [ingress.organizationId, conversation.id, ingress.occurredAt],
        );

        await this.audit.record(client, {
          action: "message.ingress",
          actorType: "system",
          metadata: {
            adapter: ingress.channel,
            idempotencyKey: ingress.idempotencyKey,
            sequenceNumber,
          },
          objectId: ingress.message.id,
          objectType: "message",
          organizationId: ingress.organizationId,
        });

        return {
          accepted: true,
          duplicate: false,
          message_id: ingress.message.id,
          idempotency_key: ingress.idempotencyKey,
          organization_id: ingress.organizationId,
          client_id: endpoint.client_id,
          conversation_id: conversation.id,
          endpoint_id: endpoint.id,
          sequence_number: sequenceNumber,
          status: MESSAGE_STATUS.ROUTED,
          routed_to: "manager",
          received_at: ingress.occurredAt,
          routed_at: ingress.routedAt,
        };
      });
      this.loadProbe.recordIngress(result, finish());

      // G-7 (Этап T4): live-пуш входящего менеджеру через C7 Redis Stream.
      // Публикуем ПОСЛЕ коммита транзакции и только для не-дубликата — повтор
      // апдейта (идемпотентный acceptIngress) не должен породить второе
      // realtime-событие. Публикация best-effort: её сбой не влияет на приём
      // (без Redis — no-op, см. C7RealtimeEventPublisher).
      if (!result.duplicate) {
        await this.publishIngressCreated(ingress, result);
      }

      return result;
    } catch (error) {
      this.loadProbe.recordIngressFailure(finish());
      throw error;
    }
  }

  /**
   * Публикует C7 `message.created` для принятого входящего сообщения. Конверт
   * собирается из нормализованного ingress + результата вставки (без доп.
   * запроса). Любая ошибка публикации подавляется — realtime не критичен для
   * приёма сообщения.
   */
  private async publishIngressCreated(
    ingress: NormalizedIngress,
    result: IngressAcceptResult,
  ): Promise<void> {
    try {
      // Вложения — в realtime-конверт (§4.3): менеджер мержит WS-сообщение
      // напрямую, поэтому без этого вложение появилось бы только после REST-
      // рефетча. Форма идентична read-path (`url` на backend-прокси).
      const attachments = ingress.message.attachments.map((attachment) => ({
        id: attachment.id,
        name:
          typeof attachment.metadata.filename === "string" && attachment.metadata.filename.trim() !== ""
            ? (attachment.metadata.filename as string)
            : attachment.id,
        contentType: attachment.mime,
        sizeBytes: attachment.size,
        url: attachmentContentUrl(attachment.id),
      }));
      await this.realtime.publishMessageCreated({
        id: result.message_id,
        organizationId: result.organization_id,
        conversationId: result.conversation_id,
        endpointId: result.endpoint_id,
        channel: ingress.channel,
        direction: MESSAGE_DIRECTION.INBOUND,
        senderType: "client",
        sequenceNumber: result.sequence_number,
        type: ingress.message.type,
        content: ingress.message.content,
        status: result.status,
        createdAt: result.received_at,
        deliveredAt: null,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
    } catch (error) {
      this.logger.warn(
        `C7 publish on ingress failed for ${result.message_id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Передаёт исходящее сообщение (уже сохранённое как direction=outbound,
   * status=routed) в integration-platform/адаптер канала: строит конверт
   * C2.EgressDelivery, переводит статус routed -> sent, фиксирует попытку
   * доставки. Порт `handoffEgressMessage` + `buildC2EgressDelivery`.
   */
  async handoffEgress(payload: EgressRequestBody): Promise<EgressHandoffResult> {
    const request = normalizeEgressRequest(payload);

    return this.database.withTenant(request.organizationId, async (client) => {
      const message = await this.requireMessage(client, request.organizationId, request.messageId);
      if (message.direction !== MESSAGE_DIRECTION.OUTBOUND) {
        throw new NotFoundException({
          code: "MESSAGE_NOT_OUTBOUND",
          description: `message ${request.messageId} is not an outbound message`,
          humanMessage: "Сообщение не является исходящим.",
        });
      }
      const endpoint = await this.requireEndpointById(
        client,
        request.organizationId,
        message.endpoint_id,
      );
      // Вложения исходящего письма (§4.3-bis follow-up п.2): непрозрачный
      // storage_ref едет на Edge, где резолвится в реальные байты при SMTP-отправке.
      const attachments = await this.loadEgressAttachments(
        client,
        request.organizationId,
        message.id,
      );
      const delivery = buildC2EgressDelivery(
        {
          id: message.id,
          organization_id: message.organization_id,
          conversation_id: message.conversation_id,
          channel: message.channel,
          type: message.type,
          content: message.content,
        },
        {
          channel: endpoint.channel,
          external_id: endpoint.external_id,
          metadata: endpoint.metadata,
        },
        attachments,
      );

      // Web Chat и другие realtime/direct-каналы: клиент подключён напрямую по
      // C7/WS, внешнего канала доставки нет. Не переводим routed -> sent и не
      // дёргаем SVC-INT — доставка терминальна по факту публикации C7 (WS-ack ->
      // delivered делает этап W3). Закрывает WG-6 у источника для любого
      // вызывающего (createMessage и внутренний /internal/egress/messages).
      if (isDirectRealtimeChannel(message.channel)) {
        return {
          accepted: true,
          message_id: message.id,
          organization_id: request.organizationId,
          conversation_id: message.conversation_id,
          endpoint_id: message.endpoint_id,
          channel: message.channel,
          status: message.status,
          adapter: request.adapter,
          attempt_no: 0,
          forwarded: false,
          degraded: false,
          error: null,
          delivery,
          sent_at: this.now(),
        };
      }

      // Проверяем и переводим статус routed -> sent машиной состояний C1.
      assertMessageStatusTransition(message.status as never, MESSAGE_STATUS.SENT);

      const occurredAt = this.now();
      const deliveryResult = await this.deliverWithAdapterFailure(client, {
        adapter: request.adapter,
        delivery,
        maxAttempts: request.maxAttempts,
        message,
        organizationId: request.organizationId,
        // Email уходит на Edge по SMTP: реальный round-trip к почтовику (>250мс,
        // дефолт M5) превышает обёртку `deliverWithAdapterFailure`, из-за чего
        // письмо доставлялось, но помечалось `failed`. Для email даём дедлайн
        // заведомо больше внутреннего вызова Edge (`edgeControlTimeoutMs`), чтобы
        // обёртка дождалась настоящего ack `sent`, а не срабатывала раньше него
        // (§4.6). Явный `request.timeoutMs` (внутренний egress-эндпоинт) — в приоритете.
        timeoutMs: request.timeoutMs ?? this.egressTimeoutMsForChannel(message.channel),
      });

      return {
        accepted: deliveryResult.accepted,
        message_id: message.id,
        organization_id: request.organizationId,
        conversation_id: message.conversation_id,
        endpoint_id: message.endpoint_id,
        channel: message.channel,
        status: deliveryResult.status,
        adapter: request.adapter,
        attempt_no: deliveryResult.attempt_count,
        forwarded: deliveryResult.forwarded,
        degraded: deliveryResult.degraded,
        error: deliveryResult.error,
        delivery,
        sent_at: occurredAt,
      };
    });
  }

  /**
   * Загружает вложения исходящего сообщения из таблицы `attachments` для egress
   * (§4.3-bis follow-up п.2). Отдаёт непрозрачный `storage_ref` + метаданные;
   * `filename` берётся из `metadata` (как на выдаче). Байты не читаются — их
   * резолвит Edge при SMTP-отправке.
   */
  private async loadEgressAttachments(
    client: PoolClient,
    organizationId: string,
    messageId: string,
  ): Promise<C2EgressAttachment[]> {
    const result = await client.query<{
      storage_ref: string;
      mime: string | null;
      size: string | number | null;
      metadata: Record<string, unknown> | null;
    }>(
      `
        SELECT storage_ref, mime, size, metadata
        FROM attachments
        WHERE organization_id = $1 AND message_id = $2
        ORDER BY created_at ASC
      `,
      [organizationId, messageId],
    );

    return result.rows.map((row) => {
      const filename = (row.metadata ?? {}).filename;
      const size = row.size === null ? undefined : Number(row.size);
      return {
        storage_ref: row.storage_ref,
        ...(typeof filename === "string" && filename.trim() !== "" ? { filename } : {}),
        ...(typeof row.mime === "string" && row.mime.trim() !== "" ? { mime: row.mime } : {}),
        ...(size !== undefined && Number.isFinite(size) ? { size } : {}),
      };
    });
  }

  /**
   * Фиксирует попытку доставки (C2.DeliveryAttempt) от integration-platform и
   * переводит статус сообщения (sent/delivered/failed). Порт
   * `recordDeliveryAttemptAndTransition`.
   */
  async recordDeliveryAttempt(payload: DeliveryAttemptBody): Promise<DeliveryAttemptResult> {
    const attempt = normalizeDeliveryAttempt(payload, () => this.now());

    return this.database.withTenant(attempt.organizationId, async (client) => {
      const message = await this.requireMessage(client, attempt.organizationId, attempt.messageId);

      await client.query(
        `
          INSERT INTO message_delivery_attempts (
            id, organization_id, message_id, adapter, attempt_no, status, error, created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
          ON CONFLICT (message_id, adapter, attempt_no) DO NOTHING
        `,
        [
          randomUUID(),
          attempt.organizationId,
          attempt.messageId,
          attempt.adapter,
          attempt.attemptNo,
          attempt.status,
          attempt.error,
          attempt.occurredAt,
        ],
      );

      let nextStatus = message.status;
      if (attempt.status === "sent" || attempt.status === "delivered" || attempt.status === "failed") {
        const target =
          attempt.status === "sent"
            ? MESSAGE_STATUS.SENT
            : attempt.status === "delivered"
              ? MESSAGE_STATUS.DELIVERED
              : MESSAGE_STATUS.FAILED;
        if (message.status !== target) {
          assertMessageStatusTransition(message.status as never, target);
          nextStatus = target;
          if (target === MESSAGE_STATUS.DELIVERED) {
            await client.query(
              `UPDATE messages SET status = $3, delivered_at = $4::timestamptz WHERE organization_id = $1 AND id = $2`,
              [attempt.organizationId, message.id, target, attempt.occurredAt],
            );
          } else {
            await client.query(
              `UPDATE messages SET status = $3 WHERE organization_id = $1 AND id = $2`,
              [attempt.organizationId, message.id, target],
            );
          }
        }
      }

      await this.audit.record(client, {
        action: "message.delivery_attempt",
        actorType: "system",
        metadata: {
          adapter: attempt.adapter,
          attemptNo: attempt.attemptNo,
          attemptStatus: attempt.status,
          error: attempt.error,
        },
        objectId: message.id,
        objectType: "message",
        organizationId: attempt.organizationId,
      });

      return {
        accepted: true,
        message_id: message.id,
        organization_id: attempt.organizationId,
        adapter: attempt.adapter,
        attempt_no: attempt.attemptNo,
        attempt_status: attempt.status,
        message_status: nextStatus,
        occurred_at: attempt.occurredAt,
      };
    });
  }

  /**
   * C8 Broadcast Delivery Coordinator: SVC-BCAST передаёт канонический C1
   * outbound draft, а CORE фиксирует связь broadcast_messages -> messages и
   * доставляет через тот же C2 egress/adapter-failure путь.
   */
  async deliverBroadcast(payload: BroadcastDeliveryDraft): Promise<BroadcastDeliveryResult> {
    const draft = normalizeBroadcastDeliveryDraft(payload);

    return this.database.withTenant(draft.organizationId, async (client) => {
      const existing = await this.findMessage(client, draft.organizationId, draft.message.id);
      if (existing) {
        const link = await this.findBroadcastMessage(
          client,
          draft.organizationId,
          draft.broadcastId,
          draft.message.id,
        );

        return {
          duplicate: true,
          delivered: existing.status === MESSAGE_STATUS.SENT,
          degraded: false,
          broadcast_id: draft.broadcastId,
          message_id: existing.id,
          conversation_id: existing.conversation_id,
          endpoint_id: existing.endpoint_id,
          sequence_number: Number(existing.sequence_number),
          status: existing.status,
          broadcast_message_status: link?.status ?? null,
          error: null,
          forwarded: false,
          attempts: [],
        };
      }

      const conversation = await this.requireConversationById(
        client,
        draft.organizationId,
        draft.message.conversation_id,
      );
      const endpoint = await this.requireEndpointById(
        client,
        draft.organizationId,
        draft.message.endpoint_id,
      );
      await this.ensureBroadcast(client, {
        broadcastId: draft.broadcastId,
        name: draft.broadcastName,
        occurredAt: draft.message.created_at,
        organizationId: draft.organizationId,
      });
      await this.lockEndpointPartition(client, draft.organizationId, endpoint.id);

      const existingAfterLock = await this.findMessage(client, draft.organizationId, draft.message.id);
      if (existingAfterLock) {
        const link = await this.findBroadcastMessage(
          client,
          draft.organizationId,
          draft.broadcastId,
          draft.message.id,
        );

        return {
          duplicate: true,
          delivered: existingAfterLock.status === MESSAGE_STATUS.SENT,
          degraded: false,
          broadcast_id: draft.broadcastId,
          message_id: existingAfterLock.id,
          conversation_id: existingAfterLock.conversation_id,
          endpoint_id: existingAfterLock.endpoint_id,
          sequence_number: Number(existingAfterLock.sequence_number),
          status: existingAfterLock.status,
          broadcast_message_status: link?.status ?? null,
          error: null,
          forwarded: false,
          attempts: [],
        };
      }

      const sequenceNumber = await this.nextSequenceNumber(client, draft.organizationId, endpoint.id);
      await client.query(
        `
          INSERT INTO messages (
            id,
            organization_id,
            conversation_id,
            endpoint_id,
            channel,
            direction,
            sender_type,
            sequence_number,
            type,
            content,
            status,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, 'outbound', 'broadcast', $6, $7, $8::jsonb, 'routed', $9::timestamptz)
        `,
        [
          draft.message.id,
          draft.organizationId,
          conversation.id,
          endpoint.id,
          endpoint.channel,
          sequenceNumber,
          draft.message.type,
          JSON.stringify(draft.message.content),
          draft.message.created_at,
        ],
      );
      await client.query(
        `
          UPDATE conversations
          SET last_message_at = GREATEST($3::timestamptz, COALESCE(last_message_at, $3::timestamptz)),
              updated_at = now()
          WHERE organization_id = $1 AND id = $2
        `,
        [draft.organizationId, conversation.id, draft.message.created_at],
      );

      await client.query(
        `
          INSERT INTO broadcast_messages (
            id,
            organization_id,
            broadcast_id,
            message_id,
            status,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, 'prepared', $5::timestamptz, $5::timestamptz)
          ON CONFLICT (organization_id, broadcast_id, message_id) DO NOTHING
        `,
        [
          uuidFromText(
            `${draft.organizationId}:broadcast_message:${draft.broadcastId}:${draft.message.id}`,
          ),
          draft.organizationId,
          draft.broadcastId,
          draft.message.id,
          draft.message.created_at,
        ],
      );

      const message = await this.requireMessage(client, draft.organizationId, draft.message.id);
      const delivery = buildC2EgressDelivery(
        {
          id: message.id,
          organization_id: message.organization_id,
          conversation_id: message.conversation_id,
          channel: message.channel,
          type: message.type,
          content: message.content,
        },
        {
          channel: endpoint.channel,
          external_id: endpoint.external_id,
          metadata: endpoint.metadata,
        },
      );
      const deliveryResult = await this.deliverWithAdapterFailure(client, {
        adapter: "broadcast",
        delivery,
        maxAttempts: null,
        message,
        organizationId: draft.organizationId,
        timeoutMs: null,
      });
      const broadcastMessageStatus =
        deliveryResult.status === MESSAGE_STATUS.SENT ? "sent" : "failed";
      const link = await this.updateBroadcastMessageStatus(client, {
        broadcastId: draft.broadcastId,
        messageId: message.id,
        occurredAt: this.now(),
        organizationId: draft.organizationId,
        status: broadcastMessageStatus,
      });

      await this.audit.record(client, {
        action: "message.broadcast_delivery",
        actorType: "system",
        metadata: {
          broadcastId: draft.broadcastId,
          deliveryStatus: deliveryResult.status,
        },
        objectId: message.id,
        objectType: "message",
        organizationId: draft.organizationId,
      });

      return {
        duplicate: false,
        delivered: deliveryResult.status === MESSAGE_STATUS.SENT,
        degraded: deliveryResult.degraded,
        broadcast_id: draft.broadcastId,
        message_id: message.id,
        conversation_id: conversation.id,
        endpoint_id: endpoint.id,
        sequence_number: sequenceNumber,
        status: deliveryResult.status,
        broadcast_message_status: link.status,
        error: deliveryResult.error,
        forwarded: deliveryResult.forwarded,
        attempts: deliveryResult.attempts,
      };
    });
  }

  /**
   * Пересылает конверт C2.EgressDelivery в integration-platform, если задан
   * `INTEGRATION_EGRESS_URL`. Без URL пересылка отключена, а доставка
   * принимается локально: статус фиксируется только в БД для dev/test-режима.
   */
  private async forwardEgressDelivery(delivery: C2EgressDelivery): Promise<AdapterDeliveryOutcome> {
    // Email — edge-owned канал: исходящее уходит на Edge Gateway через App→Edge
    // control-plane (C9.EdgeControlMessage type=egress_dispatch), где живёт боевой
    // SMTP-клиент (Этапы E2/E6, docs/plan/email-channel-production.md). Адрес —
    // туннельный релей edge-vpn-app (EDGE_CONTROL_TUNNEL_URL) при RF-разнесении,
    // иначе прямой HTTP (EDGE_CONTROL_URL) для одно-хостового стенда (MP-12). При
    // любом из них email НЕ идёт в integration-platform по HTTP-шлюзу. Прочие
    // каналы — прежний путь INTEGRATION_EGRESS_URL (ниже), без изменений.
    if (delivery.message.channel_type === "email") {
      const edgeControlUrl = resolveEdgeControlUrl();
      if (edgeControlUrl) {
        return this.forwardEgressToEdgeControl(delivery, edgeControlUrl);
      }
    }

    const url = process.env.INTEGRATION_EGRESS_URL;
    if (!url || url.trim() === "") {
      return { accepted: true, error: null, forwarded: false };
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(delivery),
      });
      if (!response.ok) {
        this.logger.warn(
          `integration-platform отклонил egress-доставку HTTP ${response.status} (${delivery.idempotency_key})`,
        );
        return {
          accepted: false,
          error: `integration-platform returned HTTP ${response.status}`,
          forwarded: false,
        };
      }

      return { accepted: true, error: null, forwarded: true };
    } catch (error) {
      this.logger.warn(
        `Не удалось переслать egress-доставку в integration-platform: ${String(error)}`,
      );
      return {
        accepted: false,
        error: error instanceof Error ? error.message : String(error),
        forwarded: false,
      };
    }
  }

  /**
   * Диспетчеризует исходящее email-сообщение на Edge Gateway через App→Edge
   * control-plane (C9.EdgeControlMessage type=egress_dispatch). Edge резолвит
   * SMTP-креды организации из своего кэша (channel_credentials_sync) и отправляет
   * письмо боевым nodemailer-транспортом. Идемпотентность — по control_id
   * (`egress-<message_id>`): повтор доставки не создаёт второе письмо (сверх того
   * Edge детерминирует Message-ID по message_id). C9-конверт собран литералом,
   * чтобы не тянуть в backend пакет контрактов (см. json-schema-validator.ts).
   */
  private async forwardEgressToEdgeControl(
    delivery: C2EgressDelivery,
    edgeControlUrl: string,
  ): Promise<AdapterDeliveryOutcome> {
    const m = delivery.message;
    const content = (m.content ?? {}) as { text?: unknown };
    const controlMessage = {
      contract: "C9.EdgeControlMessage",
      version: "1.0.0",
      control_id: `egress-${m.message_id}`,
      type: "egress_dispatch",
      organization_id: m.organization_id,
      issued_at: this.now(),
      payload: {
        message_id: m.message_id,
        channel_id: m.channel_id,
        channel_type: m.channel_type,
        recipient_ref: m.recipient_ref,
        text: typeof content.text === "string" ? content.text : "",
        ...(m.from ? { from: m.from } : {}),
        ...(m.subject ? { subject: m.subject } : {}),
        ...(m.in_reply_to ? { in_reply_to: m.in_reply_to } : {}),
        ...(m.references && m.references.length > 0 ? { references: m.references } : {}),
        // Вложения (§4.3-bis follow-up п.2): storage_ref едет на Edge, там резолвится
        // в реальные байты (EdgeAttachmentStore) и вкладывается в SMTP-письмо.
        ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
      },
    };

    const token = process.env.EDGE_CONTROL_TOKEN;
    // Независимый таймаут на сам HTTP-вызов Edge (§4.6): у fetch по умолчанию нет
    // дедлайна, поэтому при зависшем Edge backend ждал бы до таймаута внешней
    // обёртки M5. AbortController ограничивает ожидание явно (по умолчанию 15с),
    // отдельно от обёртки `deliverWithAdapterFailure`.
    const controller = new AbortController();
    const timeoutMs = this.edgeControlTimeoutMs();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(edgeControlUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token && token.trim() !== "" ? { authorization: `Bearer ${token.trim()}` } : {}),
        },
        body: JSON.stringify(controlMessage),
        signal: controller.signal,
      });
      const ack = (await response.json().catch(() => ({}))) as { status?: string; detail?: string };
      if (!response.ok) {
        this.logger.warn(
          `Edge отклонил egress email HTTP ${response.status} (${m.message_id})`,
        );
        return { accepted: false, error: `edge returned HTTP ${response.status}`, forwarded: false };
      }
      if (ack.status === "sent") {
        return { accepted: true, error: null, forwarded: true };
      }
      return {
        accepted: false,
        error: ack.detail ?? `edge egress status ${ack.status ?? "unknown"}`,
        forwarded: false,
      };
    } catch (error) {
      const reason =
        error instanceof Error && error.name === "AbortError"
          ? `edge egress timeout after ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error);
      this.logger.warn(`Не удалось диспетчеризовать email-egress на Edge: ${reason}`);
      return { accepted: false, error: reason, forwarded: false };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Дедлайн HTTP-вызова Edge control-plane для egress (§4.6). Настраивается
   * `EDGE_CONTROL_TIMEOUT_MS`; по умолчанию 15с — заведомо больше тёплой
   * SMTP-отправки (~250мс) и cold-start после прогрева, но конечен.
   */
  private edgeControlTimeoutMs(): number {
    const raw = Number(process.env.EDGE_CONTROL_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
  }

  /**
   * Дедлайн M5-обёртки `deliverWithAdapterFailure` для egress по каналу. Для
   * edge-owned каналов с реальной сетевой отправкой (email → SMTP на Edge) дефолт
   * M5 (250мс) меньше реального round-trip, поэтому письмо доставлялось, но
   * помечалось `failed`. Возвращаем дедлайн заведомо больше внутреннего вызова
   * Edge (`edgeControlTimeoutMs`, дефолт 15с) + запас, чтобы дождаться настоящего
   * ack. Настраивается `EMAIL_EGRESS_TIMEOUT_MS`. Прочие каналы — `null` (дефолт M5).
   */
  private egressTimeoutMsForChannel(channel: string): number | null {
    if (channel !== "email") {
      return null;
    }
    const raw = Number(process.env.EMAIL_EGRESS_TIMEOUT_MS);
    if (Number.isFinite(raw) && raw > 0) {
      return raw;
    }
    return this.edgeControlTimeoutMs() + 5_000;
  }

  private async deliverWithAdapterFailure(
    client: PoolClient,
    {
      adapter,
      delivery,
      maxAttempts,
      message,
      organizationId,
      timeoutMs,
    }: {
      adapter: string;
      delivery: C2EgressDelivery;
      maxAttempts?: number | null;
      message: MessageRow;
      organizationId: string;
      timeoutMs?: number | null;
    },
  ): Promise<AdapterFailureDeliveryResult> {
    const firstAttemptNo = await this.nextAttemptNo(client, organizationId, message.id, adapter);

    return this.adapterFailures.deliver({
      callAdapter: () => this.forwardEgressDelivery(delivery),
      maxAttempts,
      timeoutMs,
      recordAttempt: async ({ attemptNo, final, status, error }) => {
        const absoluteAttemptNo = firstAttemptNo + attemptNo - 1;
        const occurredAt = this.now();
        const deliveryAttempt = await this.insertDeliveryAttempt(client, {
          adapter,
          attemptNo: absoluteAttemptNo,
          error,
          messageId: message.id,
          occurredAt,
          organizationId,
          status,
        });

        let messageStatus = message.status as MessageStatus;
        if (final) {
          if (messageStatus !== status) {
            assertMessageStatusTransition(messageStatus, status);
            messageStatus = status;
            await client.query(
              `UPDATE messages SET status = $3 WHERE organization_id = $1 AND id = $2`,
              [organizationId, message.id, messageStatus],
            );
          }
          message.status = messageStatus;

          await this.audit.record(client, {
            action: "message.egress",
            actorType: "system",
            metadata: {
              adapter,
              attemptNo: absoluteAttemptNo,
              attemptStatus: status,
              error,
              forwarded: deliveryAttempt.status === MESSAGE_STATUS.SENT,
            },
            objectId: message.id,
            objectType: "message",
            organizationId,
          });
        }

        return {
          attempt_no: deliveryAttempt.attempt_no,
          status: deliveryAttempt.status,
          error: deliveryAttempt.error,
          messageStatus,
        };
      },
    });
  }

  private async insertDeliveryAttempt(
    queryable: Queryable,
    {
      adapter,
      attemptNo,
      error,
      messageId,
      occurredAt,
      organizationId,
      status,
    }: {
      adapter: string;
      attemptNo: number;
      error: string | null;
      messageId: string;
      occurredAt: string;
      organizationId: string;
      status: MessageStatus;
    },
  ): Promise<DeliveryAttemptRow> {
    const attemptId = uuidFromText(
      `${organizationId}:delivery_attempt:${messageId}:${adapter}:${attemptNo}`,
    );
    const result = await queryable.query<DeliveryAttemptRow>(
      `
        INSERT INTO message_delivery_attempts (
          id, organization_id, message_id, adapter, attempt_no, status, error, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
        ON CONFLICT (message_id, adapter, attempt_no) DO UPDATE SET
          status = EXCLUDED.status,
          error = EXCLUDED.error
        RETURNING attempt_no, status, error
      `,
      [attemptId, organizationId, messageId, adapter, attemptNo, status, error, occurredAt],
    );

    return result.rows[0];
  }

  private async resolveEndpoint(
    client: PoolClient,
    ingress: NormalizedIngress,
  ): Promise<EndpointRow> {
    if (ingress.endpointId) {
      const byId = await client.query<EndpointRow>(
        `
          SELECT id, client_id, channel, external_id, metadata
          FROM communication_endpoints
          WHERE organization_id = $1 AND id = $2
          LIMIT 1
        `,
        [ingress.organizationId, ingress.endpointId],
      );
      if (byId.rowCount && byId.rowCount > 0) {
        return byId.rows[0];
      }
    }

    const existing = await client.query<EndpointRow>(
      `
        SELECT id, client_id, channel, external_id, metadata
        FROM communication_endpoints
        WHERE organization_id = $1 AND channel = $2 AND external_id = $3
        LIMIT 1
      `,
      [ingress.organizationId, ingress.channel, ingress.endpointExternalId],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      return existing.rows[0];
    }

    const clientId =
      ingress.clientId ??
      uuidFromText(
        `${ingress.organizationId}:client:${ingress.channel}:${ingress.endpointExternalId}`,
      );
    const endpointId =
      ingress.endpointId ??
      uuidFromText(
        `${ingress.organizationId}:endpoint:${ingress.channel}:${ingress.endpointExternalId}`,
      );

    await client.query(
      `
        INSERT INTO clients (id, organization_id, display_name, created_at, updated_at)
        VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz)
        ON CONFLICT DO NOTHING
      `,
      [clientId, ingress.organizationId, ingress.senderRef ?? "Web Chat Client", ingress.occurredAt],
    );

    const metadata = {
      channel_id: ingress.channelId,
      conversation_ref: ingress.conversationRef,
      sender_ref: ingress.senderRef,
    };
    const created = await client.query<EndpointRow>(
      `
        INSERT INTO communication_endpoints (
          id, organization_id, client_id, channel, external_id, verified, metadata, created_at
        )
        VALUES ($1, $2, $3, $4, $5, false, $6::jsonb, $7::timestamptz)
        ON CONFLICT (organization_id, channel, external_id) DO UPDATE SET
          metadata = communication_endpoints.metadata || EXCLUDED.metadata
        RETURNING id, client_id, channel, external_id, metadata
      `,
      [
        endpointId,
        ingress.organizationId,
        clientId,
        ingress.channel,
        ingress.endpointExternalId,
        JSON.stringify(metadata),
        ingress.occurredAt,
      ],
    );

    return created.rows[0];
  }

  private async resolveConversation(
    client: PoolClient,
    organizationId: string,
    clientId: string,
    occurredAt: string,
    requestedConversationId?: string | null,
  ): Promise<ConversationRow> {
    if (requestedConversationId) {
      const requested = await client.query<ConversationRow>(
        `
          SELECT id, client_id
          FROM conversations
          WHERE organization_id = $1 AND id = $2
          FOR UPDATE
        `,
        [organizationId, requestedConversationId],
      );
      if (requested.rowCount && requested.rowCount > 0) {
        return requested.rows[0];
      }
    }

    const open = await client.query<ConversationRow>(
      `
        SELECT id, client_id
        FROM conversations
        WHERE organization_id = $1 AND client_id = $2 AND status <> 'closed'
        ORDER BY last_message_at DESC NULLS LAST, created_at DESC
        LIMIT 1
        FOR UPDATE
      `,
      [organizationId, clientId],
    );
    if (open.rowCount && open.rowCount > 0) {
      return open.rows[0];
    }

    const created = await client.query<ConversationRow>(
      `
        INSERT INTO conversations (id, organization_id, client_id, status, created_at, updated_at)
        VALUES ($1, $2, $3, 'open', $4::timestamptz, $4::timestamptz)
        RETURNING id, client_id
      `,
      [requestedConversationId ?? randomUUID(), organizationId, clientId, occurredAt],
    );

    return created.rows[0];
  }

  private async findMessage(
    queryable: Queryable,
    organizationId: string,
    messageId: string,
  ): Promise<MessageRow | null> {
    const result = await queryable.query<MessageRow>(
      `
        SELECT
          id,
          organization_id,
          conversation_id,
          endpoint_id,
          channel,
          direction,
          type,
          content,
          status,
          sequence_number
        FROM messages
        WHERE organization_id = $1 AND id = $2
      `,
      [organizationId, messageId],
    );

    return result.rowCount && result.rowCount > 0 ? result.rows[0] : null;
  }

  private async requireMessage(
    queryable: Queryable,
    organizationId: string,
    messageId: string,
  ): Promise<MessageRow> {
    const message = await this.findMessage(queryable, organizationId, messageId);
    if (!message) {
      throw new NotFoundException({
        code: "RESOURCE_NOT_FOUND",
        description: `message ${messageId} was not found`,
        humanMessage: "Сообщение не найдено.",
      });
    }

    return message;
  }

  private async requireEndpointById(
    queryable: Queryable,
    organizationId: string,
    endpointId: string,
  ): Promise<EndpointRow> {
    const result = await queryable.query<EndpointRow>(
      `
        SELECT id, client_id, channel, external_id, metadata
        FROM communication_endpoints
        WHERE organization_id = $1 AND id = $2
      `,
      [organizationId, endpointId],
    );
    if (result.rowCount === 0) {
      throw new NotFoundException({
        code: "RESOURCE_NOT_FOUND",
        description: `communication endpoint ${endpointId} was not found`,
        humanMessage: "Endpoint не найден.",
      });
    }

    return result.rows[0];
  }

  private async requireConversationById(
    queryable: Queryable,
    organizationId: string,
    conversationId: string,
  ): Promise<ConversationRow> {
    const result = await queryable.query<ConversationRow>(
      `
        SELECT id, client_id
        FROM conversations
        WHERE organization_id = $1 AND id = $2
      `,
      [organizationId, conversationId],
    );
    if (result.rowCount === 0) {
      throw new NotFoundException({
        code: "RESOURCE_NOT_FOUND",
        description: `conversation ${conversationId} was not found`,
        humanMessage: "Диалог не найден.",
      });
    }

    return result.rows[0];
  }

  private async findBroadcastMessage(
    queryable: Queryable,
    organizationId: string,
    broadcastId: string,
    messageId: string,
  ): Promise<BroadcastMessageRow | null> {
    const result = await queryable.query<BroadcastMessageRow>(
      `
        SELECT status
        FROM broadcast_messages
        WHERE organization_id = $1 AND broadcast_id = $2 AND message_id = $3
      `,
      [organizationId, broadcastId, messageId],
    );

    return result.rowCount && result.rowCount > 0 ? result.rows[0] : null;
  }

  private async ensureBroadcast(
    queryable: Queryable,
    {
      broadcastId,
      name,
      occurredAt,
      organizationId,
    }: {
      broadcastId: string;
      name: string | null;
      occurredAt: string;
      organizationId: string;
    },
  ): Promise<void> {
    const trimmedName = typeof name === "string" ? name.trim() : "";
    const resolvedName = trimmedName === "" ? `Broadcast ${broadcastId}` : trimmedName;

    await queryable.query(
      `
        INSERT INTO broadcasts (id, organization_id, name, status, created_at, updated_at)
        VALUES ($1, $2, $3, 'running', $4::timestamptz, $4::timestamptz)
        ON CONFLICT (id) DO NOTHING
      `,
      [broadcastId, organizationId, resolvedName, occurredAt],
    );
  }

  private async updateBroadcastMessageStatus(
    queryable: Queryable,
    {
      broadcastId,
      messageId,
      occurredAt,
      organizationId,
      status,
    }: {
      broadcastId: string;
      messageId: string;
      occurredAt: string;
      organizationId: string;
      status: string;
    },
  ): Promise<BroadcastMessageRow> {
    const result = await queryable.query<BroadcastMessageRow>(
      `
        UPDATE broadcast_messages
        SET status = $1,
            updated_at = GREATEST($2::timestamptz, updated_at)
        WHERE organization_id = $3 AND broadcast_id = $4 AND message_id = $5
        RETURNING status
      `,
      [status, occurredAt, organizationId, broadcastId, messageId],
    );
    if (result.rowCount === 0) {
      throw new NotFoundException({
        code: "RESOURCE_NOT_FOUND",
        description: `broadcast message link ${broadcastId}/${messageId} was not found`,
        humanMessage: "Связь рассылки с сообщением не найдена.",
      });
    }

    return result.rows[0];
  }

  private async lockEndpointPartition(
    queryable: Queryable,
    organizationId: string,
    endpointId: string,
  ): Promise<void> {
    await queryable.query(
      `SELECT id FROM communication_endpoints WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [organizationId, endpointId],
    );
  }

  private async nextSequenceNumber(
    queryable: Queryable,
    organizationId: string,
    endpointId: string,
  ): Promise<number> {
    const result = await queryable.query<{ next_sequence_number: string }>(
      `
        SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_sequence_number
        FROM messages
        WHERE organization_id = $1 AND endpoint_id = $2
      `,
      [organizationId, endpointId],
    );

    return Number(result.rows[0].next_sequence_number);
  }

  private async nextAttemptNo(
    queryable: Queryable,
    organizationId: string,
    messageId: string,
    adapter: string,
  ): Promise<number> {
    const result = await queryable.query<{ next_attempt_no: string }>(
      `
        SELECT COALESCE(MAX(attempt_no), 0) + 1 AS next_attempt_no
        FROM message_delivery_attempts
        WHERE organization_id = $1 AND message_id = $2 AND adapter = $3
      `,
      [organizationId, messageId, adapter],
    );

    return Number(result.rows[0].next_attempt_no);
  }

  private async duplicateIngressResult(
    client: PoolClient,
    ingress: NormalizedIngress,
    existing: MessageRow,
  ): Promise<IngressAcceptResult> {
    const sequence = await client.query<{ sequence_number: string; client_id: string }>(
      `
        SELECT m.sequence_number, e.client_id
        FROM messages m
        JOIN communication_endpoints e
          ON e.organization_id = m.organization_id AND e.id = m.endpoint_id
        WHERE m.organization_id = $1 AND m.id = $2
      `,
      [ingress.organizationId, existing.id],
    );
    const row = sequence.rows[0];

    return {
      accepted: true,
      duplicate: true,
      message_id: existing.id,
      idempotency_key: ingress.idempotencyKey,
      organization_id: ingress.organizationId,
      client_id: row?.client_id ?? "",
      conversation_id: existing.conversation_id,
      endpoint_id: existing.endpoint_id,
      sequence_number: Number(row?.sequence_number ?? 0),
      status: existing.status,
      routed_to: "manager",
      received_at: ingress.occurredAt,
      routed_at: ingress.routedAt,
    };
  }
}
