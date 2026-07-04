/**
 * Внутренний messaging-путь production-сборки backend (issue #189, пункты 1–3).
 *
 * Реализует на исполняемом NestJS/TypeScript то, что раньше существовало только
 * в неисполняемых `.mjs`-прототипах (`communication-core-m1.mjs`):
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
import { AuditService } from "../audit/audit.service";
import {
  assertMessageStatusTransition,
  MESSAGE_DIRECTION,
  MESSAGE_STATUS,
} from "./message-status";
import {
  buildC2EgressDelivery,
  normalizeDeliveryAttempt,
  normalizeEgressRequest,
  normalizeIngressEnvelope,
  uuidFromText,
} from "./internal-messaging.dto";
import type {
  C2EgressDelivery,
  DeliveryAttemptBody,
  EgressRequestBody,
  IngressEnvelope,
  NormalizedIngress,
} from "./internal-messaging.dto";

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

@Injectable()
export class InternalMessagingService {
  private readonly logger = new Logger(InternalMessagingService.name);

  constructor(
    private readonly database: PgDatabase,
    private readonly audit: AuditService,
  ) {}

  private now(): string {
    return new Date().toISOString();
  }

  /**
   * Принимает входящее сообщение (C2.IngressMessage), идемпотентно сохраняет его
   * в статусе `routed` и связывает с клиентом/endpoint-ом/диалогом. Порт
   * `acceptIngressMessage` + `recordInboundMessage` (Postgres-хранилище m1).
   */
  async acceptIngress(payload: IngressEnvelope): Promise<IngressAcceptResult> {
    const ingress = normalizeIngressEnvelope(payload, () => this.now());
    // Валидируем переход received -> routed портированной машиной состояний C1
    // до записи: сообщение сохраняется сразу в статусе routed, т.к. в схеме нет
    // отдельных колонок routed_at/sent_at (см. миграцию m1_schema).
    assertMessageStatusTransition(MESSAGE_STATUS.RECEIVED, MESSAGE_STATUS.ROUTED);

    return this.database.withTenant(ingress.organizationId, async (client) => {
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
      // Проверяем и переводим статус routed -> sent машиной состояний C1.
      assertMessageStatusTransition(message.status as never, MESSAGE_STATUS.SENT);

      const endpoint = await this.requireEndpointById(
        client,
        request.organizationId,
        message.endpoint_id,
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
      );

      const attemptNo = await this.nextAttemptNo(
        client,
        request.organizationId,
        message.id,
        request.adapter,
      );
      const occurredAt = this.now();

      await client.query(
        `
          INSERT INTO message_delivery_attempts (
            id, organization_id, message_id, adapter, attempt_no, status, created_at
          )
          VALUES ($1, $2, $3, $4, $5, 'sent', $6::timestamptz)
        `,
        [randomUUID(), request.organizationId, message.id, request.adapter, attemptNo, occurredAt],
      );
      await client.query(
        `UPDATE messages SET status = 'sent' WHERE organization_id = $1 AND id = $2`,
        [request.organizationId, message.id],
      );
      await this.audit.record(client, {
        action: "message.egress",
        actorType: "system",
        metadata: { adapter: request.adapter, attemptNo },
        objectId: message.id,
        objectType: "message",
        organizationId: request.organizationId,
      });

      const forwarded = await this.forwardEgressDelivery(delivery);

      return {
        accepted: true,
        message_id: message.id,
        organization_id: request.organizationId,
        conversation_id: message.conversation_id,
        endpoint_id: message.endpoint_id,
        channel: message.channel,
        status: MESSAGE_STATUS.SENT,
        adapter: request.adapter,
        attempt_no: attemptNo,
        forwarded,
        delivery,
        sent_at: occurredAt,
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
   * Пересылает конверт C2.EgressDelivery в integration-platform, если задан
   * `INTEGRATION_EGRESS_URL`. Без URL пересылка отключена (статус фиксируется
   * только в БД) — это осознанная деградация, см. .env.example.
   */
  private async forwardEgressDelivery(delivery: C2EgressDelivery): Promise<boolean> {
    const url = process.env.INTEGRATION_EGRESS_URL;
    if (!url || url.trim() === "") {
      return false;
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
        return false;
      }

      return true;
    } catch (error) {
      this.logger.warn(
        `Не удалось переслать egress-доставку в integration-platform: ${String(error)}`,
      );
      return false;
    }
  }

  private async resolveEndpoint(
    client: PoolClient,
    ingress: NormalizedIngress,
  ): Promise<EndpointRow> {
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

    const clientId = uuidFromText(
      `${ingress.organizationId}:client:${ingress.channel}:${ingress.endpointExternalId}`,
    );
    const endpointId = uuidFromText(
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
  ): Promise<ConversationRow> {
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
      [randomUUID(), organizationId, clientId, occurredAt],
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
        SELECT id, organization_id, conversation_id, endpoint_id, channel, direction, type, content, status
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
