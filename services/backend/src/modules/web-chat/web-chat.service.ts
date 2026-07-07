import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";

import { Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";

import { PgDatabase } from "../../common/database/database.service";
import type { Queryable } from "../../common/database/database.service";
import { C7RealtimeEventPublisher } from "../communication-core/c7-realtime-event.publisher";
import { mapMessage } from "../communication-core/communication-core.dto";
import type {
  MessageListResponseDto,
  MessageResponseDto,
  MessageRow,
} from "../communication-core/communication-core.dto";
import type {
  CreateOrResumeWebChatSessionDto,
  SendWebChatMessageDto,
  StartWebChatEmailCodeDto,
  VerifyWebChatEmailCodeDto,
  WebChatEmailCodeStartResponseDto,
  WebChatMessagesQueryDto,
  WebChatSessionResponseDto,
} from "./web-chat.dto";

const WEB_CHAT_CHANNEL = "web_chat";
const CODE_TTL_SECONDS = 5 * 60;
const MAX_CODE_ATTEMPTS = 5;
const LOCKOUT_SECONDS = 15 * 60;

interface WebChatSessionRow {
  client_id: string;
  conversation_id: string | null;
  email: string | null;
  endpoint_id: string;
  metadata: Record<string, unknown>;
  verified: boolean;
}

interface WebChatEmailCodeRow {
  attempt_count: number;
  code_hash: string;
  consumed_at: Date | string | null;
  email: string;
  endpoint_id: string;
  expires_at: Date | string;
  id: string;
  locked_until: Date | string | null;
}

@Injectable()
export class WebChatService {
  constructor(
    private readonly database: PgDatabase,
    private readonly realtime: C7RealtimeEventPublisher,
  ) {}

  async createOrResumeSession(
    input: CreateOrResumeWebChatSessionDto,
  ): Promise<WebChatSessionResponseDto> {
    const organizationId = input.organization_id;
    const visitorSessionId = normalizeVisitorSessionId(input.visitor_session_id);

    return this.database.withTenant(organizationId, async (client) => {
      const existing = await this.findSession(client, organizationId, visitorSessionId);
      if (existing) {
        const conversationId = await this.resolveConversation(
          client,
          organizationId,
          existing.client_id,
          input.conversation_id,
          existing.conversation_id,
        );

        return sessionResponse({
          conversationId,
          endpointId: existing.endpoint_id,
          organizationId,
          visitorSessionId,
          verifiedEmail: existing.verified ? existing.email : null,
        });
      }

      const clientId = randomUUID();
      const endpointId = randomUUID();
      const conversationId = input.conversation_id ?? randomUUID();

      await client.query(
        `
          INSERT INTO clients (id, organization_id, display_name)
          VALUES ($1, $2, $3)
        `,
        [clientId, organizationId, "Web Chat visitor"],
      );
      await client.query(
        `
          INSERT INTO communication_endpoints (
            id,
            organization_id,
            client_id,
            channel,
            external_id,
            verified,
            metadata
          )
          VALUES ($1, $2, $3, $4, $5, false, $6::jsonb)
        `,
        [
          endpointId,
          organizationId,
          clientId,
          WEB_CHAT_CHANNEL,
          externalId(visitorSessionId),
          JSON.stringify({
            visitor_session_id: visitorSessionId,
          }),
        ],
      );
      await client.query(
        `
          INSERT INTO conversations (id, organization_id, client_id, status)
          VALUES ($1, $2, $3, 'open')
        `,
        [conversationId, organizationId, clientId],
      );

      return sessionResponse({
        conversationId,
        endpointId,
        organizationId,
        visitorSessionId,
      });
    });
  }

  async listMessages(
    conversationId: string,
    query: WebChatMessagesQueryDto,
  ): Promise<MessageListResponseDto> {
    const organizationId = query.organization_id;
    return this.database.withTenant(organizationId, async (client) => {
      await this.requireSessionConversation(
        client,
        organizationId,
        query.visitor_session_id,
        conversationId,
      );

      const limit = normalizeLimit(query.limit);
      const afterSequenceNumber =
        typeof query.after_sequence_number === "number" ? query.after_sequence_number : null;
      const beforeSequenceNumber = parseBeforeCursor(query.cursor);
      const params: unknown[] = [organizationId, conversationId, limit];
      let predicate = "";
      let order = "sequence_number DESC";

      if (afterSequenceNumber !== null) {
        params.push(afterSequenceNumber);
        predicate = "AND sequence_number > $4";
        order = "sequence_number ASC";
      } else if (beforeSequenceNumber !== null) {
        params.push(beforeSequenceNumber);
        predicate = "AND sequence_number < $4";
      }

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
          WHERE organization_id = $1
            AND conversation_id = $2
            ${predicate}
          ORDER BY ${order}, created_at DESC, id DESC
          LIMIT $3
        `,
        params,
      );
      const newestFirst = result.rows.map(mapMessage);
      const items = afterSequenceNumber === null ? newestFirst.reverse() : newestFirst;
      const firstSequenceNumber = items[0]?.sequenceNumber ?? null;
      const hasMore =
        afterSequenceNumber === null &&
        firstSequenceNumber !== null &&
        (await this.hasMessagesBefore(client, organizationId, conversationId, firstSequenceNumber));

      return {
        items,
        page: {
          limit,
          nextCursor: hasMore ? `before:${firstSequenceNumber}` : undefined,
          total: items.length,
        },
      };
    });
  }

  async sendMessage(input: SendWebChatMessageDto): Promise<MessageResponseDto> {
    const organizationId = input.organization_id;
    const message = await this.database.withTenant(organizationId, async (client) => {
      await this.requireSessionConversation(
        client,
        organizationId,
        input.visitor_session_id,
        input.conversation_id,
        input.endpoint_id,
      );
      await this.lockEndpoint(client, organizationId, input.endpoint_id);

      const existing = await this.findMessage(client, organizationId, input.idempotency_key);
      if (existing) {
        return mapMessage(existing);
      }

      const sequenceNumber = await this.nextSequenceNumber(
        client,
        organizationId,
        input.endpoint_id,
      );
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
          VALUES ($1, $2, $3, $4, $5, 'inbound', 'client', $6, $7, $8::jsonb, 'received', now())
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
          input.idempotency_key,
          organizationId,
          input.conversation_id,
          input.endpoint_id,
          WEB_CHAT_CHANNEL,
          sequenceNumber,
          messageType(input.body),
          JSON.stringify(messageContent(input.body)),
        ],
      );

      await client.query(
        `
          UPDATE conversations
          SET last_message_at = $3, updated_at = $3
          WHERE organization_id = $1 AND id = $2
        `,
        [organizationId, input.conversation_id, result.rows[0].created_at],
      );

      return mapMessage(result.rows[0]);
    });

    await this.realtime.publishMessageCreated(message);
    return message;
  }

  async startEmailCode(
    input: StartWebChatEmailCodeDto,
  ): Promise<WebChatEmailCodeStartResponseDto> {
    const organizationId = input.organization_id;
    const email = normalizeEmail(input.email);
    const code = generateCode();
    const requestId = randomUUID();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + CODE_TTL_SECONDS * 1000);

    await this.database.withTenant(organizationId, async (client) => {
      const session = await this.requireSessionConversation(
        client,
        organizationId,
        input.visitor_session_id,
      );

      await client.query(
        `
          INSERT INTO web_chat_email_codes (
            id,
            organization_id,
            endpoint_id,
            email,
            code_hash,
            expires_at,
            consumed_at,
            attempt_count,
            locked_until,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6::timestamptz, NULL, 0, NULL, $7::timestamptz)
        `,
        [
          requestId,
          organizationId,
          session.endpoint_id,
          email,
          hashCode(session.endpoint_id, email, code),
          expiresAt.toISOString(),
          createdAt.toISOString(),
        ],
      );
    });

    return {
      accepted: true,
      requestId,
      expiresAt: expiresAt.toISOString(),
      ...(shouldExposeDebugCode() ? { debugCode: code } : {}),
    };
  }

  async verifyEmailCode(input: VerifyWebChatEmailCodeDto): Promise<WebChatSessionResponseDto> {
    const organizationId = input.organization_id;
    const email = normalizeEmail(input.email);

    return this.database.withTenant(organizationId, async (client) => {
      const session = await this.requireSessionConversation(
        client,
        organizationId,
        input.visitor_session_id,
      );
      const code = await this.requireLatestEmailCode(
        client,
        organizationId,
        session.endpoint_id,
        email,
      );

      assertCodeCanBeVerified(code);
      if (!codeMatches(code.code_hash, session.endpoint_id, email, input.code)) {
        await this.recordFailedAttempt(client, code);
        throw unauthorized("Invalid email verification code.");
      }

      const consumed = await client.query(
        `
          UPDATE web_chat_email_codes
          SET consumed_at = now()
          WHERE id = $1 AND consumed_at IS NULL
          RETURNING id
        `,
        [code.id],
      );
      if (consumed.rowCount === 0) {
        throw unauthorized("Email verification code has already been used.");
      }

      await client.query(
        `
          UPDATE communication_endpoints
          SET verified = true,
              verified_at = now(),
              metadata = metadata || $3::jsonb
          WHERE organization_id = $1 AND id = $2
        `,
        [
          organizationId,
          session.endpoint_id,
          JSON.stringify({
            email,
            email_verified_at: new Date().toISOString(),
          }),
        ],
      );
      await client.query(
        `
          INSERT INTO client_identity_links (
            id,
            organization_id,
            client_id,
            endpoint_id,
            link_type,
            evidence,
            created_by_actor_type
          )
          VALUES ($1, $2, $3, $4, 'verified_email', $5::jsonb, 'system')
          ON CONFLICT (organization_id, endpoint_id)
          WHERE reverted_at IS NULL
          DO UPDATE SET
            link_type = EXCLUDED.link_type,
            evidence = EXCLUDED.evidence
        `,
        [
          randomUUID(),
          organizationId,
          session.client_id,
          session.endpoint_id,
          JSON.stringify({ email, code_id: code.id }),
        ],
      );

      if (!session.conversation_id) {
        throw notFound("web chat conversation", input.visitor_session_id);
      }

      return sessionResponse({
        conversationId: session.conversation_id,
        endpointId: session.endpoint_id,
        organizationId,
        visitorSessionId: input.visitor_session_id,
        verifiedEmail: email,
      });
    });
  }

  private async findSession(
    queryable: Queryable,
    organizationId: string,
    visitorSessionId: string,
  ): Promise<WebChatSessionRow | null> {
    const result = await queryable.query<WebChatSessionRow>(
      `
        SELECT
          e.id AS endpoint_id,
          e.client_id,
          e.verified,
          e.metadata,
          e.metadata->>'email' AS email,
          c.id AS conversation_id
        FROM communication_endpoints e
        LEFT JOIN LATERAL (
          SELECT id
          FROM conversations
          WHERE organization_id = e.organization_id
            AND client_id = e.client_id
            AND status <> 'closed'
          ORDER BY last_message_at DESC NULLS LAST, created_at DESC, id
          LIMIT 1
        ) c ON true
        WHERE e.organization_id = $1
          AND e.channel = $2
          AND e.external_id = $3
        LIMIT 1
      `,
      [organizationId, WEB_CHAT_CHANNEL, externalId(visitorSessionId)],
    );

    return result.rowCount && result.rowCount > 0 ? result.rows[0] : null;
  }

  private async resolveConversation(
    queryable: Queryable,
    organizationId: string,
    clientId: string,
    requestedConversationId?: string,
    existingConversationId?: string | null,
  ): Promise<string> {
    if (requestedConversationId) {
      const requested = await queryable.query<{ id: string }>(
        `
          SELECT id
          FROM conversations
          WHERE organization_id = $1 AND id = $2 AND client_id = $3
          LIMIT 1
        `,
        [organizationId, requestedConversationId, clientId],
      );
      if (requested.rowCount && requested.rowCount > 0) {
        return requested.rows[0].id;
      }
    }

    if (existingConversationId) {
      return existingConversationId;
    }

    const conversationId = requestedConversationId ?? randomUUID();
    await queryable.query(
      `
        INSERT INTO conversations (id, organization_id, client_id, status)
        VALUES ($1, $2, $3, 'open')
      `,
      [conversationId, organizationId, clientId],
    );
    return conversationId;
  }

  private async requireSessionConversation(
    queryable: Queryable,
    organizationId: string,
    visitorSessionId: string,
    conversationId?: string,
    endpointId?: string,
  ): Promise<WebChatSessionRow> {
    const params: unknown[] = [organizationId, WEB_CHAT_CHANNEL, externalId(visitorSessionId)];
    let conversationPredicate = "";
    let endpointPredicate = "";

    if (conversationId) {
      params.push(conversationId);
      conversationPredicate = `AND c.id = $${params.length}`;
    }
    if (endpointId) {
      params.push(endpointId);
      endpointPredicate = `AND e.id = $${params.length}`;
    }

    const result = await queryable.query<WebChatSessionRow>(
      `
        SELECT
          e.id AS endpoint_id,
          e.client_id,
          e.verified,
          e.metadata,
          e.metadata->>'email' AS email,
          c.id AS conversation_id
        FROM communication_endpoints e
        LEFT JOIN conversations c
          ON c.organization_id = e.organization_id
         AND c.client_id = e.client_id
         AND c.status <> 'closed'
         ${conversationPredicate}
        WHERE e.organization_id = $1
          AND e.channel = $2
          AND e.external_id = $3
          ${endpointPredicate}
        ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC, c.id
        LIMIT 1
      `,
      params,
    );

    if (
      !result.rowCount ||
      result.rowCount === 0 ||
      (conversationId && !result.rows[0].conversation_id)
    ) {
      throw notFound("web chat session", visitorSessionId);
    }

    return result.rows[0];
  }

  private async lockEndpoint(
    queryable: Queryable,
    organizationId: string,
    endpointId: string,
  ): Promise<void> {
    await queryable.query(
      "SELECT id FROM communication_endpoints WHERE organization_id = $1 AND id = $2 FOR UPDATE",
      [organizationId, endpointId],
    );
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

    return result.rowCount && result.rowCount > 0 ? result.rows[0] : null;
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

  private async hasMessagesBefore(
    queryable: Queryable,
    organizationId: string,
    conversationId: string,
    sequenceNumber: number,
  ): Promise<boolean> {
    const result = await queryable.query(
      `
        SELECT id
        FROM messages
        WHERE organization_id = $1
          AND conversation_id = $2
          AND sequence_number < $3
        LIMIT 1
      `,
      [organizationId, conversationId, sequenceNumber],
    );

    return Boolean(result.rowCount && result.rowCount > 0);
  }

  private async requireLatestEmailCode(
    queryable: Queryable,
    organizationId: string,
    endpointId: string,
    email: string,
  ): Promise<WebChatEmailCodeRow> {
    const result = await queryable.query<WebChatEmailCodeRow>(
      `
        SELECT id, endpoint_id, email, code_hash, expires_at, consumed_at, attempt_count, locked_until
        FROM web_chat_email_codes
        WHERE organization_id = $1
          AND endpoint_id = $2
          AND lower(email) = lower($3)
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `,
      [organizationId, endpointId, email],
    );

    if (!result.rowCount || result.rowCount === 0) {
      throw unauthorized("Email verification code was not requested.");
    }
    return result.rows[0];
  }

  private async recordFailedAttempt(
    queryable: Queryable,
    code: WebChatEmailCodeRow,
  ): Promise<void> {
    const attempts = Number(code.attempt_count) + 1;
    const lockedUntil =
      attempts >= MAX_CODE_ATTEMPTS
        ? new Date(Date.now() + LOCKOUT_SECONDS * 1000).toISOString()
        : null;

    await queryable.query(
      `
        UPDATE web_chat_email_codes
        SET attempt_count = $2,
            locked_until = $3::timestamptz
        WHERE id = $1
      `,
      [code.id, attempts, lockedUntil],
    );
  }
}

function sessionResponse({
  conversationId,
  endpointId,
  organizationId,
  visitorSessionId,
  verifiedEmail,
}: {
  conversationId: string;
  endpointId: string;
  organizationId: string;
  visitorSessionId: string;
  verifiedEmail?: null | string;
}): WebChatSessionResponseDto {
  return {
    conversationId,
    endpointId,
    organizationId,
    visitorSessionId,
    ...(verifiedEmail ? { verifiedEmail } : {}),
  };
}

function normalizeVisitorSessionId(value?: string): string {
  const trimmed = value?.trim();
  return trimmed || `web-chat-visitor-${randomUUID()}`;
}

function externalId(visitorSessionId: string): string {
  return `web_chat:${visitorSessionId}`;
}

function normalizeLimit(value: number): number {
  return Math.max(1, Math.min(100, value));
}

function parseBeforeCursor(value?: string): number | null {
  if (!value?.startsWith("before:")) {
    return null;
  }
  const sequenceNumber = Number(value.slice("before:".length));
  return Number.isSafeInteger(sequenceNumber) && sequenceNumber > 0 ? sequenceNumber : null;
}

function messageType(body: Record<string, unknown>): string {
  return typeof body.type === "string" && body.type.trim() ? body.type.trim() : "text";
}

function messageContent(body: Record<string, unknown>): Record<string, unknown> {
  const text = typeof body.text === "string" ? body.text : "";
  return { text };
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function hashCode(endpointId: string, email: string, code: string): string {
  return createHmac("sha256", emailCodeSecret())
    .update(`${endpointId}:${normalizeEmail(email)}:${code}`)
    .digest("hex");
}

function codeMatches(expectedHash: string, endpointId: string, email: string, code: string): boolean {
  const actualHash = hashCode(endpointId, email, code);
  const expected = Buffer.from(expectedHash, "hex");
  const actual = Buffer.from(actualHash, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function emailCodeSecret(): string {
  return (
    process.env.WEB_CHAT_EMAIL_CODE_SECRET?.trim() ||
    process.env.AUTH_HASH_SECRET?.trim() ||
    "bridge-web-chat-email-code-dev-secret"
  );
}

function shouldExposeDebugCode(): boolean {
  return (
    process.env.WEB_CHAT_EMAIL_CODE_DEBUG_RESPONSE === "1" ||
    process.env.NODE_ENV !== "production"
  );
}

function assertCodeCanBeVerified(code: WebChatEmailCodeRow): void {
  if (code.consumed_at) {
    throw unauthorized("Email verification code has already been used.");
  }
  if (new Date(code.expires_at).getTime() <= Date.now()) {
    throw unauthorized("Email verification code has expired.");
  }
  if (code.locked_until && new Date(code.locked_until).getTime() > Date.now()) {
    throw unauthorized("Email verification code is temporarily locked.");
  }
}

function notFound(objectType: string, id: string): NotFoundException {
  return new NotFoundException({
    code: "RESOURCE_NOT_FOUND",
    description: `${objectType} ${id} was not found`,
    humanMessage: "Ресурс не найден.",
  });
}

function unauthorized(description: string): UnauthorizedException {
  return new UnauthorizedException({
    code: "WEB_CHAT_EMAIL_CODE_INVALID",
    description,
    humanMessage: "Код подтверждения недействителен.",
  });
}
