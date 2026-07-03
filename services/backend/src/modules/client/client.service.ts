import { randomUUID } from "node:crypto";

import { Injectable, NotFoundException } from "@nestjs/common";

import { PgDatabase } from "../../common/database/database.service";
import type { Queryable } from "../../common/database/database.service";
import { AuditService } from "../audit/audit.service";
import { CommunicationCoreProxyService } from "../communication-core/communication-core-proxy.service";
import {
  mapClient,
  mapClientNote,
  mapClientTag,
} from "./client.dto";
import type {
  AddClientEndpointDto,
  ClientEndpointResponseDto,
  ClientListResponseDto,
  ClientMergeResponseDto,
  ClientNoteResponseDto,
  ClientNoteRow,
  ClientResponseDto,
  ClientRow,
  ClientTagResponseDto,
  ClientTagRow,
  CreateClientDto,
  CreateClientNoteDto,
  CreateClientTagDto,
  MergeClientsDto,
} from "./client.dto";

export interface ClientMutationContext {
  actorUserId?: string;
  requestId?: string;
}

@Injectable()
export class ClientService {
  constructor(
    private readonly database: PgDatabase,
    private readonly audit: AuditService,
    private readonly core: CommunicationCoreProxyService,
  ) {}

  async listClients(
    organizationId: string,
    limit: number,
    q?: string,
  ): Promise<ClientListResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      const result = await client.query<ClientRow>(
        `
          SELECT id, organization_id, display_name, anonymized_at, created_at, updated_at
          FROM clients
          WHERE organization_id = $1
            AND ($3::text IS NULL OR display_name ILIKE '%' || $3 || '%')
          ORDER BY created_at DESC, id
          LIMIT $2
        `,
        [organizationId, limit, q ?? null],
      );

      return {
        items: result.rows.map(mapClient),
        page: { limit, total: result.rows.length },
      };
    });
  }

  async createClient(
    organizationId: string,
    payload: CreateClientDto,
    context: ClientMutationContext,
  ): Promise<ClientResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      const result = await client.query<ClientRow>(
        `
          INSERT INTO clients (id, organization_id, display_name)
          VALUES ($1, $2, $3)
          RETURNING id, organization_id, display_name, anonymized_at, created_at, updated_at
        `,
        [randomUUID(), organizationId, payload.displayName ?? null],
      );

      await this.audit.record(client, {
        action: "client.create",
        actorUserId: context.actorUserId,
        objectId: result.rows[0].id,
        objectType: "client",
        organizationId,
        requestId: context.requestId,
      });

      return mapClient(result.rows[0]);
    });
  }

  async getClient(organizationId: string, clientId: string): Promise<ClientResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      const result = await client.query<ClientRow>(
        `
          SELECT id, organization_id, display_name, anonymized_at, created_at, updated_at
          FROM clients
          WHERE organization_id = $1 AND id = $2
        `,
        [organizationId, clientId],
      );

      if (result.rowCount === 0) {
        throw notFound("client", clientId);
      }

      return mapClient(result.rows[0]);
    });
  }

  async addNote(
    organizationId: string,
    clientId: string,
    payload: CreateClientNoteDto,
    context: ClientMutationContext,
  ): Promise<ClientNoteResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      await this.ensureClientExists(client, organizationId, clientId);
      const result = await client.query<ClientNoteRow>(
        `
          INSERT INTO client_notes (id, organization_id, client_id, author_user_id, body)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING id, client_id, author_user_id, body, created_at
        `,
        [randomUUID(), organizationId, clientId, context.actorUserId ?? null, payload.body],
      );

      await this.audit.record(client, {
        action: "client.note.create",
        actorUserId: context.actorUserId,
        objectId: clientId,
        objectType: "client",
        organizationId,
        requestId: context.requestId,
      });

      return mapClientNote(result.rows[0]);
    });
  }

  async addTag(
    organizationId: string,
    clientId: string,
    payload: CreateClientTagDto,
    context: ClientMutationContext,
  ): Promise<ClientTagResponseDto> {
    return this.database.withTenant(organizationId, async (client) => {
      await this.ensureClientExists(client, organizationId, clientId);
      const result = await client.query<ClientTagRow>(
        `
          INSERT INTO client_tags (id, organization_id, client_id, tag, created_by)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (organization_id, client_id, tag) DO UPDATE SET tag = EXCLUDED.tag
          RETURNING id, client_id, tag, created_by, created_at
        `,
        [randomUUID(), organizationId, clientId, payload.tag, context.actorUserId ?? null],
      );

      await this.audit.record(client, {
        action: "client.tag.create",
        actorUserId: context.actorUserId,
        metadata: { tag: payload.tag },
        objectId: clientId,
        objectType: "client",
        organizationId,
        requestId: context.requestId,
      });

      return mapClientTag(result.rows[0]);
    });
  }

  async addEndpoint(
    organizationId: string,
    clientId: string,
    payload: AddClientEndpointDto,
    context: ClientMutationContext,
  ): Promise<ClientEndpointResponseDto> {
    const endpoint = await this.core.addClientEndpoint(organizationId, clientId, payload);

    await this.database.withTenant(organizationId, async (client) => {
      await this.audit.record(client, {
        action: "client.endpoint.proxy",
        actorUserId: context.actorUserId,
        metadata: { endpointId: endpoint.id, proxiedTo: "SVC-CORE" },
        objectId: clientId,
        objectType: "client",
        organizationId,
        requestId: context.requestId,
      });
    });

    return endpoint;
  }

  async mergeClients(
    organizationId: string,
    payload: MergeClientsDto,
    context: ClientMutationContext,
  ): Promise<ClientMergeResponseDto> {
    const response = await this.core.mergeClients(organizationId, payload);

    await this.database.withTenant(organizationId, async (client) => {
      await this.audit.record(client, {
        action: "client.merge.proxy",
        actorUserId: context.actorUserId,
        metadata: {
          proxiedTo: "SVC-CORE",
          reason: payload.reason ?? null,
          sourceClientId: payload.sourceClientId,
        },
        objectId: payload.targetClientId,
        objectType: "client",
        organizationId,
        requestId: context.requestId,
      });
    });

    return response;
  }

  private async ensureClientExists(
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
}

function notFound(objectType: string, id: string): NotFoundException {
  return new NotFoundException({
    code: "RESOURCE_NOT_FOUND",
    description: `${objectType} ${id} was not found`,
    humanMessage: "Ресурс не найден.",
  });
}
