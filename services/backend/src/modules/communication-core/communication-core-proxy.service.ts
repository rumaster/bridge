import { randomUUID } from "node:crypto";

import { Injectable, NotFoundException } from "@nestjs/common";

import { PgDatabase } from "../../common/database/database.service";
import type { Queryable } from "../../common/database/database.service";
import { isUuidV4 } from "../../common/request-context";
import { AuditService } from "../audit/audit.service";
import { mapClientEndpoint } from "../client/client.dto";
import type {
  AddClientEndpointDto,
  ClientEndpointResponseDto,
  ClientEndpointRow,
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

@Injectable()
export class CommunicationCoreProxyService {
  constructor(
    private readonly database: PgDatabase,
    private readonly audit: AuditService,
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
    return this.database.withTenant(organizationId, async (client) => {
      await this.requireConversation(client, organizationId, payload.conversationId);
      const endpoint = await this.requireEndpoint(client, organizationId, payload.endpointId);
      const sequenceNumber =
        payload.sequenceNumber ??
        (await this.nextSequenceNumber(client, organizationId, payload.conversationId));
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
          payload.endpointId,
          payload.channel ?? endpoint.channel,
          payload.direction ?? "outbound",
          payload.senderType ?? "manager",
          sequenceNumber,
          payload.type ?? "text",
          JSON.stringify(payload.content),
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
  ): Promise<ClientMergeResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      await this.requireClient(client, organizationId, payload.sourceClientId);
      await this.requireClient(client, organizationId, payload.targetClientId);

      return {
        accepted: true,
        mode: "mock-core",
        sourceClientId: payload.sourceClientId,
        targetClientId: payload.targetClientId,
      };
    });
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

  private async nextSequenceNumber(
    queryable: Queryable,
    organizationId: string,
    conversationId: string,
  ): Promise<number> {
    const result = await queryable.query<{ next_sequence_number: string }>(
      `
        SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_sequence_number
        FROM messages
        WHERE organization_id = $1 AND conversation_id = $2
      `,
      [organizationId, conversationId],
    );

    return Number(result.rows[0].next_sequence_number);
  }
}

function notFound(objectType: string, id: string): NotFoundException {
  return new NotFoundException({
    code: "RESOURCE_NOT_FOUND",
    description: `${objectType} ${id} was not found`,
    humanMessage: "Ресурс не найден.",
  });
}
