import { randomUUID } from "node:crypto";

import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";

import { PgDatabase } from "../../common/database/database.service";
import type { Queryable } from "../../common/database/database.service";
import { isUuidV4 } from "../../common/request-context";
import { AuditService } from "../audit/audit.service";
import { mapClientEndpoint, mapClientIdentityLink } from "../client/client.dto";
import { C7RealtimeEventPublisher } from "./c7-realtime-event.publisher";
import { InternalMessagingService, isDirectRealtimeChannel } from "./internal-messaging.service";
import type {
  AddClientEndpointDto,
  ClientEndpointResponseDto,
  ClientEndpointRow,
  ClientIdentityLinkResponseDto,
  ClientIdentityLinkRow,
  ClientMergeResponseDto,
  MergeClientsDto,
} from "../client/client.dto";
import {
  mapConversation,
  mapMessage,
} from "./communication-core.dto";
import type {
  ConversationListResponseDto,
  ConversationResponseDto,
  ConversationRow,
  CreateMessageDto,
  MessageListResponseDto,
  MessageResponseDto,
  MessageRow,
} from "./communication-core.dto";

export interface CoreMutationContext {
  actorUserId?: string;
  idempotencyKey?: string;
  requestId?: string;
}

interface CreateIdentityLinkParams {
  actorUserId?: string;
  endpointId: string;
  evidence: Record<string, unknown>;
  linkType: "automatic" | "link_code" | "manual" | "verified_email" | "verified_phone";
  targetClientId: string;
}

@Injectable()
export class CommunicationCoreProxyService {
  private readonly logger = new Logger(CommunicationCoreProxyService.name);

  constructor(
    private readonly database: PgDatabase,
    private readonly audit: AuditService,
    private readonly realtime: C7RealtimeEventPublisher,
    private readonly messaging: InternalMessagingService,
  ) {}

  async listConversations(
    organizationId: string,
    limit: number,
  ): Promise<ConversationListResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      const result = await client.query<ConversationRow>(
        `
          SELECT id, organization_id, client_id, status, last_message_at, created_at, updated_at
          FROM conversations
          WHERE organization_id = $1
          ORDER BY COALESCE(last_message_at, created_at) DESC, id
          LIMIT $2
        `,
        [organizationId, limit],
      );

      return {
        items: result.rows.map(mapConversation),
        page: { limit, total: result.rows.length },
      };
    });
  }

  async getConversation(
    organizationId: string,
    conversationId: string,
  ): Promise<ConversationResponseDto> {
    return this.database.withTenant(organizationId, async (client) =>
      mapConversation(await this.requireConversation(client, organizationId, conversationId)),
    );
  }

  async listConversationMessages(
    organizationId: string,
    conversationId: string,
    limit: number,
  ): Promise<MessageListResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      await this.requireConversation(client, organizationId, conversationId);
      const result = await client.query<MessageRow>(
        `
          SELECT
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
            created_at,
            delivered_at
          FROM messages
          WHERE organization_id = $1 AND conversation_id = $2
          ORDER BY sequence_number ASC
          LIMIT $3
        `,
        [organizationId, conversationId, limit],
      );

      return {
        items: result.rows.map(mapMessage),
        page: { limit, total: result.rows.length },
      };
    });
  }

  async getMessage(organizationId: string, messageId: string): Promise<MessageResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      const result = await client.query<MessageRow>(
        `
          SELECT
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
            created_at,
            delivered_at
          FROM messages
          WHERE organization_id = $1 AND id = $2
        `,
        [organizationId, messageId],
      );

      if (result.rowCount === 0) {
        throw notFound("message", messageId);
      }

      return mapMessage(result.rows[0]);
    });
  }

  async createMessage(
    organizationId: string,
    payload: CreateMessageDto,
    context: CoreMutationContext,
  ): Promise<MessageResponseDto> {
    const message = await this.database.withTenant(organizationId, async (client) => {
      await this.requireConversation(client, organizationId, payload.conversationId);
      // endpointId опционален: если клиент (manager-workspace) его не прислал —
      // резолвим endpoint диалога сами (по последнему сообщению / endpoint-у клиента).
      const endpointId =
        payload.endpointId ??
        (await this.resolveConversationReplyEndpoint(
          client,
          organizationId,
          payload.conversationId,
        ));
      const endpoint = await this.requireEndpoint(client, organizationId, endpointId);
      await this.lockEndpointPartition(client, organizationId, endpointId);
      const sequenceNumber =
        payload.sequenceNumber ??
        (await this.nextSequenceNumber(client, organizationId, endpointId));
      // content принимаем строкой или объектом; строку нормализуем в {text}.
      const content =
        typeof payload.content === "string" ? { text: payload.content } : payload.content;
      const messageId =
        payload.id ??
        (context.idempotencyKey && isUuidV4(context.idempotencyKey)
          ? context.idempotencyKey
          : randomUUID());

      const result = await client.query<MessageRow>(
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
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, now())
          RETURNING
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
            created_at,
            delivered_at
        `,
        [
          messageId,
          organizationId,
          payload.conversationId,
          endpointId,
          payload.channel ?? endpoint.channel,
          payload.direction ?? "outbound",
          payload.senderType ?? "manager",
          sequenceNumber,
          payload.type ?? "text",
          JSON.stringify(content),
          payload.status ?? "routed",
        ],
      );

      await client.query(
        `
          UPDATE conversations
          SET last_message_at = $3, updated_at = $3
          WHERE organization_id = $1 AND id = $2
        `,
        [organizationId, payload.conversationId, result.rows[0].created_at],
      );
      await this.audit.record(client, {
        action: "message.create",
        actorUserId: context.actorUserId,
        metadata: { idempotencyKey: context.idempotencyKey ?? null },
        objectId: result.rows[0].id,
        objectType: "message",
        organizationId,
        requestId: context.requestId,
      });

      return mapMessage(result.rows[0]);
    });
    await this.realtime.publishMessageCreated(message);

    // Доставка ответа во внешний канал (egress). Раньше createMessage только
    // сохранял сообщение (routed) и публиковал C7, но НЕ инициировал доставку —
    // из-за чего ответ менеджера не доходил до клиента. Триггерим handoffEgress
    // после коммита (best-effort, идемпотентно по message_id). Рассылки идут
    // отдельным путём (deliverBroadcast) — пропускаем. Realtime/direct-каналы
    // (Web Chat) доставляются публикацией C7 выше и НЕ имеют внешнего egress —
    // не дёргаем SVC-INT, иначе фантомный failed/delivered (WG-6, план W1).
    if (
      message.direction === "outbound" &&
      message.status === "routed" &&
      message.senderType !== "broadcast" &&
      !isDirectRealtimeChannel(message.channel)
    ) {
      try {
        const handoff = await this.messaging.handoffEgress({
          organization_id: organizationId,
          message_id: message.id,
          adapter: message.channel,
        });
        message.status = handoff.status;
      } catch (error) {
        this.logger.warn(
          `egress handoff failed for message ${message.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return message;
  }

  async addClientEndpoint(
    organizationId: string,
    clientId: string,
    payload: AddClientEndpointDto,
  ): Promise<ClientEndpointResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      await this.requireClient(client, organizationId, clientId);
      const result = await client.query<ClientEndpointRow>(
        `
          INSERT INTO communication_endpoints (
            id,
            organization_id,
            client_id,
            channel,
            external_id,
            verified,
            verified_at,
            metadata
          )
          VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 THEN now() ELSE NULL END, $7::jsonb)
          RETURNING id, client_id, channel, external_id, verified, metadata, created_at
        `,
        [
          randomUUID(),
          organizationId,
          clientId,
          payload.channel,
          payload.externalId,
          payload.verified ?? false,
          JSON.stringify(payload.metadata ?? {}),
        ],
      );

      return mapClientEndpoint(result.rows[0]);
    });
  }

  async mergeClients(
    organizationId: string,
    payload: MergeClientsDto,
    context: CoreMutationContext = {},
  ): Promise<ClientMergeResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      if (payload.sourceClientId === payload.targetClientId) {
        throw badRequest("sourceClientId and targetClientId must be different");
      }

      await this.requireClient(client, organizationId, payload.sourceClientId);
      await this.requireClient(client, organizationId, payload.targetClientId);

      const targetConversation = await this.resolveConversation(
        client,
        organizationId,
        payload.targetClientId,
      );
      const endpoints = await client.query<ClientEndpointRow>(
        `
          SELECT id, client_id, channel, external_id, verified, metadata, created_at
          FROM communication_endpoints
          WHERE organization_id = $1 AND client_id = $2
          ORDER BY created_at ASC
          FOR UPDATE
        `,
        [organizationId, payload.sourceClientId],
      );
      const links: ClientMergeResponseDto["links"] = [];
      const movedEndpointCount = endpoints.rowCount ?? endpoints.rows.length;
      let movedMessageCount = 0;

      for (const endpoint of endpoints.rows) {
        const previousConversation = await this.findConversationForEndpoint(
          client,
          organizationId,
          endpoint.id,
          payload.sourceClientId,
        );
        const link = await this.createIdentityLink(client, organizationId, {
          actorUserId: context.actorUserId,
          endpointId: endpoint.id,
          evidence: {
            previous_client_id: payload.sourceClientId,
            previous_conversation_id: previousConversation?.id ?? null,
            reason: payload.reason ?? null,
            target_client_id: payload.targetClientId,
            target_conversation_id: targetConversation.id,
          },
          linkType: "manual",
          targetClientId: payload.targetClientId,
        });
        links.push(link);

        await client.query(
          `
            UPDATE communication_endpoints
            SET client_id = $3
            WHERE organization_id = $1 AND id = $2
          `,
          [organizationId, endpoint.id, payload.targetClientId],
        );
        const moved = await client.query(
          `
            UPDATE messages
            SET conversation_id = $3
            WHERE organization_id = $1
              AND endpoint_id = $2
              AND conversation_id <> $3
          `,
          [organizationId, endpoint.id, targetConversation.id],
        );
        movedMessageCount += moved.rowCount ?? 0;

        if (previousConversation) {
          await client.query(
            `
              UPDATE conversations
              SET status = 'closed',
                  updated_at = now()
              WHERE organization_id = $1 AND id = $2
            `,
            [organizationId, previousConversation.id],
          );
          await this.recalculateConversationLastMessage(
            client,
            organizationId,
            previousConversation.id,
          );
        }
      }

      await this.recalculateConversationLastMessage(client, organizationId, targetConversation.id);
      await this.audit.record(client, {
        action: "client.merge",
        actorUserId: context.actorUserId,
        metadata: {
          movedEndpointCount,
          movedMessageCount,
          reason: payload.reason ?? null,
          sourceClientId: payload.sourceClientId,
        },
        objectId: payload.targetClientId,
        objectType: "client",
        organizationId,
        requestId: context.requestId,
      });

      return {
        accepted: true,
        links,
        mode: "core-m2",
        movedEndpointCount,
        movedMessageCount,
        sourceClientId: payload.sourceClientId,
        targetClientId: payload.targetClientId,
      };
    });
  }

  private async resolveConversation(
    queryable: Queryable,
    organizationId: string,
    clientId: string,
  ): Promise<ConversationRow> {
    const existing = await queryable.query<ConversationRow>(
      `
        SELECT id, organization_id, client_id, status, last_message_at, created_at, updated_at
        FROM conversations
        WHERE organization_id = $1
          AND client_id = $2
          AND status = 'open'
        ORDER BY COALESCE(last_message_at, created_at) DESC, id
        LIMIT 1
        FOR UPDATE
      `,
      [organizationId, clientId],
    );

    if (existing.rowCount && existing.rowCount > 0) {
      return existing.rows[0];
    }

    const created = await queryable.query<ConversationRow>(
      `
        INSERT INTO conversations (id, organization_id, client_id, status)
        VALUES ($1, $2, $3, 'open')
        RETURNING id, organization_id, client_id, status, last_message_at, created_at, updated_at
      `,
      [randomUUID(), organizationId, clientId],
    );

    return created.rows[0];
  }

  private async findConversationForEndpoint(
    queryable: Queryable,
    organizationId: string,
    endpointId: string,
    clientId: string,
  ): Promise<ConversationRow | null> {
    const fromMessages = await queryable.query<ConversationRow>(
      `
        SELECT
          c.id,
          c.organization_id,
          c.client_id,
          c.status,
          c.last_message_at,
          c.created_at,
          c.updated_at
        FROM messages m
        JOIN conversations c
          ON c.organization_id = m.organization_id
         AND c.id = m.conversation_id
        WHERE m.organization_id = $1
          AND m.endpoint_id = $2
          AND c.client_id = $3
        ORDER BY m.created_at ASC, m.sequence_number ASC, c.id
        LIMIT 1
        FOR UPDATE OF c
      `,
      [organizationId, endpointId, clientId],
    );

    if (fromMessages.rowCount && fromMessages.rowCount > 0) {
      return fromMessages.rows[0];
    }

    const fallback = await queryable.query<ConversationRow>(
      `
        SELECT id, organization_id, client_id, status, last_message_at, created_at, updated_at
        FROM conversations
        WHERE organization_id = $1
          AND client_id = $2
          AND status = 'open'
        ORDER BY COALESCE(last_message_at, created_at) DESC, id
        LIMIT 1
        FOR UPDATE
      `,
      [organizationId, clientId],
    );

    return fallback.rowCount && fallback.rowCount > 0 ? fallback.rows[0] : null;
  }

  private async createIdentityLink(
    queryable: Queryable,
    organizationId: string,
    params: CreateIdentityLinkParams,
  ): Promise<ClientIdentityLinkResponseDto> {
    const actorType = params.actorUserId ? "user" : "system";

    await queryable.query(
      `
        UPDATE client_identity_links
        SET reverted_at = now(),
            reverted_by = $3,
            reverted_by_actor_type = $4,
            reverted_reason = $5
        WHERE organization_id = $1
          AND endpoint_id = $2
          AND reverted_at IS NULL
      `,
      [
        organizationId,
        params.endpointId,
        params.actorUserId ?? null,
        actorType,
        "Superseded by manual client merge.",
      ],
    );

    const result = await queryable.query<ClientIdentityLinkRow>(
      `
        INSERT INTO client_identity_links (
          id,
          organization_id,
          client_id,
          endpoint_id,
          link_type,
          evidence,
          created_by,
          created_by_actor_type
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
        RETURNING id, client_id, endpoint_id, link_type, evidence, created_at, reverted_at
      `,
      [
        randomUUID(),
        organizationId,
        params.targetClientId,
        params.endpointId,
        params.linkType,
        JSON.stringify(params.evidence),
        params.actorUserId ?? null,
        actorType,
      ],
    );

    return mapClientIdentityLink(result.rows[0]);
  }

  private async recalculateConversationLastMessage(
    queryable: Queryable,
    organizationId: string,
    conversationId: string,
  ): Promise<void> {
    await queryable.query(
      `
        UPDATE conversations
        SET last_message_at = (
              SELECT MAX(created_at)
              FROM messages
              WHERE organization_id = $1 AND conversation_id = $2
            ),
            updated_at = now()
        WHERE organization_id = $1 AND id = $2
      `,
      [organizationId, conversationId],
    );
  }

  private async requireConversation(
    queryable: Queryable,
    organizationId: string,
    conversationId: string,
  ): Promise<ConversationRow> {
    const result = await queryable.query<ConversationRow>(
      `
        SELECT id, organization_id, client_id, status, last_message_at, created_at, updated_at
        FROM conversations
        WHERE organization_id = $1 AND id = $2
      `,
      [organizationId, conversationId],
    );

    if (result.rowCount === 0) {
      throw notFound("conversation", conversationId);
    }

    return result.rows[0];
  }

  private async requireClient(
    queryable: Queryable,
    organizationId: string,
    clientId: string,
  ): Promise<void> {
    const result = await queryable.query(
      "SELECT id FROM clients WHERE organization_id = $1 AND id = $2",
      [organizationId, clientId],
    );

    if (result.rowCount === 0) {
      throw notFound("client", clientId);
    }
  }

  private async requireEndpoint(
    queryable: Queryable,
    organizationId: string,
    endpointId: string,
  ): Promise<{ channel: string }> {
    const result = await queryable.query<{ channel: string }>(
      "SELECT channel FROM communication_endpoints WHERE organization_id = $1 AND id = $2",
      [organizationId, endpointId],
    );

    if (result.rowCount === 0) {
      throw notFound("communication endpoint", endpointId);
    }

    return result.rows[0];
  }

  /**
   * Резолвит целевой endpoint диалога для ответа, когда клиент не прислал
   * endpointId. Берёт endpoint последнего сообщения диалога (туда и отвечаем),
   * иначе — первый endpoint клиента этого диалога.
   */
  private async resolveConversationReplyEndpoint(
    queryable: Queryable,
    organizationId: string,
    conversationId: string,
  ): Promise<string> {
    const latest = await queryable.query<{ endpoint_id: string }>(
      `
        SELECT endpoint_id
        FROM messages
        WHERE organization_id = $1 AND conversation_id = $2
        ORDER BY created_at DESC, sequence_number DESC
        LIMIT 1
      `,
      [organizationId, conversationId],
    );
    if (latest.rowCount && latest.rows[0].endpoint_id) {
      return latest.rows[0].endpoint_id;
    }

    const clientEndpoint = await queryable.query<{ id: string }>(
      `
        SELECT ce.id
        FROM communication_endpoints ce
        JOIN conversations c
          ON c.client_id = ce.client_id AND c.organization_id = ce.organization_id
        WHERE c.organization_id = $1 AND c.id = $2
        ORDER BY ce.created_at ASC
        LIMIT 1
      `,
      [organizationId, conversationId],
    );
    if (clientEndpoint.rowCount && clientEndpoint.rows[0].id) {
      return clientEndpoint.rows[0].id;
    }

    throw new BadRequestException({
      code: "ENDPOINT_REQUIRED",
      description: "Could not resolve a target endpoint for the conversation.",
      humanMessage: "Не удалось определить получателя ответа для диалога.",
    });
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

  private async lockEndpointPartition(
    queryable: Queryable,
    organizationId: string,
    endpointId: string,
  ): Promise<void> {
    await queryable.query(
      `
        SELECT id
        FROM communication_endpoints
        WHERE organization_id = $1 AND id = $2
        FOR UPDATE
      `,
      [organizationId, endpointId],
    );
  }
}

function notFound(objectType: string, id: string): NotFoundException {
  return new NotFoundException({
    code: "RESOURCE_NOT_FOUND",
    description: `${objectType} ${id} was not found`,
    humanMessage: "Ресурс не найден.",
  });
}

function badRequest(description: string): BadRequestException {
  return new BadRequestException({
    code: "VALIDATION_FAILED",
    description,
    humanMessage: "Некорректный запрос.",
  });
}
