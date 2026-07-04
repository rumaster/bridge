import { createHmac, randomBytes, randomUUID } from "node:crypto";

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";

import {
  AUTH_HASH_SECRET_ENV,
  AuthSessionContext,
  DEFAULT_AUTH_HASH_SECRET,
  primaryRole,
} from "../../common/auth/auth-context";
import { hashSessionToken } from "../../common/auth/session-auth.guard";
import { PgDatabase } from "../../common/database/database.service";
import type { Queryable } from "../../common/database/database.service";
import { AuditService } from "../audit/audit.service";
import type { OrganizationResponseDto } from "../organization/organization.dto";
import {
  AcceptInvitationDto,
  CreateFirstAdministratorInvitationDto,
  CreateInvitationDto,
  InvitationResponseDto,
  ProvisionOrganizationDto,
  normalizeInvitationContact,
} from "./identity-m4.dto";

const DEFAULT_INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const PLATFORM_LOOKUP_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000000";

interface OrganizationRow {
  created_at: Date | string;
  description: null | string;
  id: string;
  locale: string;
  name: string;
  status: string;
  timezone: string;
  updated_at: Date | string;
}

interface InvitationRow {
  accepted_at: Date | string | null;
  contact_type: "email" | "telegram";
  contact_value: string;
  created_at: Date | string;
  created_by: string | null;
  expires_at: Date | string;
  id: string;
  organization_id: string;
  organization_name?: string;
  organization_status?: string;
  role_code: "administrator" | "manager";
  role_id: string;
  token_hash: string;
}

interface RoleRow {
  code: "administrator" | "manager";
  id: string;
}

interface UserSessionRecord {
  displayName: string;
  email: null | string;
  id: string;
  organizationId: string;
  organizationName: string;
  organizationStatus: string;
  roleCodes: ("administrator" | "manager")[];
  telegramUsername: null | string;
}

@Injectable()
export class IdentityM4Service {
  constructor(
    private readonly database: PgDatabase,
    private readonly audit: AuditService,
  ) {}

  async provisionOrganization(
    payload: ProvisionOrganizationDto,
    auth: AuthSessionContext,
    requestId?: string,
  ): Promise<OrganizationResponseDto> {
    return this.database.withTenant(
      auth.organization.id,
      async (client) => {
        const now = new Date();
        const id = randomUUID();
        const result = await client.query<OrganizationRow>(
          `
            INSERT INTO organizations (
              id,
              name,
              description,
              timezone,
              locale,
              status,
              created_at,
              updated_at
            )
            VALUES ($1, $2, $3, $4, $5, 'active', $6::timestamptz, $6::timestamptz)
            RETURNING id, name, description, timezone, locale, status, created_at, updated_at
          `,
          [
            id,
            payload.name.trim(),
            normalizeNullableText(payload.description),
            payload.timezone?.trim() ?? "UTC",
            payload.locale?.trim() ?? "ru-RU",
            now.toISOString(),
          ],
        );
        const organization = mapOrganization(result.rows[0]);

        await this.audit.record(client, {
          action: "organization.provision",
          metadata: {
            platformActorUserId: auth.user.id,
            status: organization.status,
          },
          objectId: organization.id,
          objectType: "organization",
          organizationId: organization.id,
          requestId,
        });

        return organization;
      },
      { isPlatformOperator: true },
    );
  }

  async createFirstAdministratorInvitation(
    organizationId: string,
    payload: CreateFirstAdministratorInvitationDto,
    auth: AuthSessionContext,
    requestId?: string,
  ): Promise<InvitationResponseDto> {
    return this.database.withTenant(
      auth.organization.id,
      async (client) => {
        const organization = await this.getOrganizationInTransaction(client, organizationId);
        if (organization.status !== "active") {
          throw new UnauthorizedException({
            code: "ORGANIZATION_INACTIVE",
            description: "Organization is not active.",
            humanMessage: "Организация не активна.",
          });
        }

        const existingAdministratorCount = await this.countAdministrators(
          client,
          organizationId,
        );
        const pendingAdministratorCount = await this.countPendingInvitations(
          client,
          organizationId,
          "administrator",
        );

        if (existingAdministratorCount > 0 || pendingAdministratorCount > 0) {
          throw new ConflictException({
            code: "ADMINISTRATOR_EXISTS",
            description:
              "Organization already has an Administrator or pending Administrator invitation.",
            humanMessage: "Первый администратор уже создан или приглашён.",
          });
        }

        return this.createInvitationInTransaction(client, {
          contactType: payload.contactType,
          contactValue: payload.contactValue,
          createdBy: null,
          displayName: payload.displayName,
          expiresInSeconds: payload.expiresInSeconds,
          organizationId,
          platformActorUserId: auth.user.id,
          requestId,
          roleCode: "administrator",
        });
      },
      { isPlatformOperator: true },
    );
  }

  async createInvitation(
    payload: CreateInvitationDto,
    auth: AuthSessionContext,
    requestId?: string,
  ): Promise<InvitationResponseDto> {
    if (payload.organizationId !== auth.organization.id) {
      throw new UnauthorizedException({
        code: "TENANT_FORBIDDEN",
        description: "Administrator can create invitations only in their organization.",
        humanMessage: "Недостаточно прав для приглашения в другую организацию.",
      });
    }

    return this.database.withTenant(payload.organizationId, async (client) =>
      this.createInvitationInTransaction(client, {
        contactType: payload.contactType,
        contactValue: payload.contactValue,
        createdBy: auth.user.id,
        displayName: payload.displayName,
        expiresInSeconds: payload.expiresInSeconds,
        organizationId: payload.organizationId,
        requestId,
        roleCode: payload.roleCode ?? "manager",
      }),
    );
  }

  async acceptInvitation(
    payload: AcceptInvitationDto,
    request: { ip?: null | string; userAgent?: null | string } = {},
  ): Promise<Record<string, unknown>> {
    return this.database.withTenant(
      PLATFORM_LOOKUP_ORGANIZATION_ID,
      async (client) => {
        const tokenHash = hashInvitationToken(payload.token);
        const invitationResult = await client.query<InvitationRow>(
          `
            SELECT
              i.*,
              r.code AS role_code,
              o.name AS organization_name,
              o.status AS organization_status
            FROM invitations i
            JOIN roles r ON r.id = i.role_id
            JOIN organizations o ON o.id = i.organization_id
            WHERE i.token_hash = $1
            LIMIT 1
          `,
          [tokenHash],
        );

        if (invitationResult.rowCount === 0) {
          throw invalidInvitation("Invitation token is invalid.");
        }

        const invitation = invitationResult.rows[0];
        if (invitation.accepted_at) {
          throw invalidInvitation("Invitation token has already been used.");
        }

        if (new Date(invitation.expires_at).getTime() <= Date.now()) {
          throw invalidInvitation("Invitation token has expired.");
        }

        const accepted = await client.query<InvitationRow>(
          `
            UPDATE invitations
            SET accepted_at = now()
            WHERE id = $1 AND accepted_at IS NULL
            RETURNING *
          `,
          [invitation.id],
        );
        if (accepted.rowCount === 0) {
          throw invalidInvitation("Invitation token has already been used.");
        }

        const user = await this.createUserForInvitation(client, invitation, {
          displayName: payload.displayName?.trim() || invitation.contact_value,
        });
        const session = await this.createSessionForUser(client, user, request);

        await this.audit.record(client, {
          action: "invitation.accept",
          actorUserId: user.id,
          metadata: {
            authMethod: "invitation",
            contactType: invitation.contact_type,
            roleCode: invitation.role_code,
          },
          objectId: invitation.id,
          objectType: "invitation",
          organizationId: invitation.organization_id,
          requestId: invitation.id,
        });
        await this.audit.record(client, {
          action: "auth.login.success",
          actorUserId: user.id,
          ip: request.ip ?? null,
          metadata: {
            authMethod: "invitation",
            invitationId: invitation.id,
            roleCodes: user.roleCodes,
            sessionExpiresAt: session.expiresAt,
          },
          objectId: session.id,
          objectType: "auth_session",
          organizationId: invitation.organization_id,
          requestId: invitation.id,
        });

        return sessionResponse(user, session);
      },
      { isPlatformOperator: true },
    );
  }

  async blockOrganization(
    organizationId: string,
    auth: AuthSessionContext,
    requestId?: string,
  ): Promise<OrganizationResponseDto> {
    return this.database.withTenant(
      auth.organization.id,
      async (client) => {
        const before = await this.getOrganizationInTransaction(client, organizationId);
        const result = await client.query<OrganizationRow>(
          `
            UPDATE organizations
            SET status = 'blocked',
                updated_at = now()
            WHERE id = $1
            RETURNING id, name, description, timezone, locale, status, created_at, updated_at
          `,
          [organizationId],
        );

        if (result.rowCount === 0) {
          throw notFound("organization", organizationId);
        }

        await this.audit.record(client, {
          action: "organization.block",
          metadata: {
            platformActorUserId: auth.user.id,
            previousStatus: before.status,
            status: "blocked",
          },
          objectId: organizationId,
          objectType: "organization",
          organizationId,
          requestId,
        });

        return mapOrganization(result.rows[0]);
      },
      { isPlatformOperator: true },
    );
  }

  private async createInvitationInTransaction(
    client: Queryable,
    input: {
      contactType: "email" | "telegram";
      contactValue: string;
      createdBy: null | string;
      displayName?: string;
      expiresInSeconds?: number;
      organizationId: string;
      platformActorUserId?: string;
      requestId?: string;
      roleCode: "administrator" | "manager";
    },
  ): Promise<InvitationResponseDto> {
    const organization = await this.getOrganizationInTransaction(client, input.organizationId);
    if (organization.status !== "active") {
      throw new UnauthorizedException({
        code: "ORGANIZATION_INACTIVE",
        description: "Organization is not active.",
        humanMessage: "Организация не активна.",
      });
    }

    const role = await this.getRoleInTransaction(client, input.roleCode);
    const token = createInvitationToken();
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() +
        (input.expiresInSeconds ?? DEFAULT_INVITATION_TTL_SECONDS) * 1000,
    );
    const contactValue = normalizeContact(input.contactType, input.contactValue);
    const result = await client.query<InvitationRow>(
      `
        INSERT INTO invitations (
          id,
          organization_id,
          contact_type,
          contact_value,
          role_id,
          token_hash,
          expires_at,
          accepted_at,
          created_by,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, NULL, $8, $9::timestamptz)
        RETURNING *, $10::text AS role_code
      `,
      [
        randomUUID(),
        input.organizationId,
        input.contactType,
        contactValue,
        role.id,
        hashInvitationToken(token),
        expiresAt.toISOString(),
        input.createdBy,
        now.toISOString(),
        role.code,
      ],
    );
    const invitation = mapInvitation(result.rows[0], token);

    await this.audit.record(client, {
      action: "invitation.create",
      actorUserId: input.createdBy ?? undefined,
      metadata: {
        contactType: input.contactType,
        expiresAt: invitation.expiresAt,
        platformActorUserId: input.platformActorUserId,
        roleCode: role.code,
      },
      objectId: invitation.id,
      objectType: "invitation",
      organizationId: input.organizationId,
      requestId: input.requestId ?? invitation.id,
    });

    return invitation;
  }

  private async getOrganizationInTransaction(
    client: Queryable,
    organizationId: string,
  ): Promise<OrganizationResponseDto> {
    const result = await client.query<OrganizationRow>(
      `
        SELECT id, name, description, timezone, locale, status, created_at, updated_at
        FROM organizations
        WHERE id = $1
      `,
      [organizationId],
    );

    if (result.rowCount === 0) {
      throw notFound("organization", organizationId);
    }

    return mapOrganization(result.rows[0]);
  }

  private async getRoleInTransaction(
    client: Queryable,
    roleCode: "administrator" | "manager",
  ): Promise<RoleRow> {
    const result = await client.query<RoleRow>(
      "SELECT id, code FROM roles WHERE code = $1 LIMIT 1",
      [roleCode],
    );

    if (result.rowCount === 0) {
      throw new BadRequestException({
        code: "ROLE_UNKNOWN",
        description: `Role ${roleCode} does not exist.`,
        humanMessage: "Неизвестная роль приглашения.",
      });
    }

    return result.rows[0];
  }

  private async countAdministrators(
    client: Queryable,
    organizationId: string,
  ): Promise<number> {
    const result = await client.query<{ count: number }>(
      `
        SELECT count(*)::int AS count
        FROM users u
        JOIN user_roles ur
          ON ur.user_id = u.id AND ur.organization_id = u.organization_id
        JOIN roles r ON r.id = ur.role_id
        WHERE u.organization_id = $1 AND r.code = 'administrator'
      `,
      [organizationId],
    );

    return result.rows[0].count;
  }

  private async countPendingInvitations(
    client: Queryable,
    organizationId: string,
    roleCode: "administrator" | "manager",
  ): Promise<number> {
    const result = await client.query<{ count: number }>(
      `
        SELECT count(*)::int AS count
        FROM invitations i
        JOIN roles r ON r.id = i.role_id
        WHERE i.organization_id = $1
          AND r.code = $2
          AND i.accepted_at IS NULL
          AND i.expires_at > now()
      `,
      [organizationId, roleCode],
    );

    return result.rows[0].count;
  }

  private async createUserForInvitation(
    client: Queryable,
    invitation: InvitationRow,
    input: { displayName: string },
  ): Promise<UserSessionRecord> {
    const userId = randomUUID();
    const result = await client.query<UserSessionRecord>(
      `
        WITH inserted_user AS (
          INSERT INTO users (
            id,
            organization_id,
            telegram_username,
            email,
            display_name,
            status,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, 'active', now(), now())
          RETURNING id, organization_id, telegram_username, email, display_name
        ),
        inserted_role AS (
          INSERT INTO user_roles (user_id, role_id, organization_id)
          VALUES ($1, $6, $2)
          RETURNING role_id
        )
        SELECT
          u.id,
          u.organization_id AS "organizationId",
          u.telegram_username AS "telegramUsername",
          u.email,
          u.display_name AS "displayName",
          o.name AS "organizationName",
          o.status AS "organizationStatus",
          ARRAY[$7::text] AS "roleCodes"
        FROM inserted_user u
        JOIN inserted_role ir ON true
        JOIN organizations o ON o.id = u.organization_id
      `,
      [
        userId,
        invitation.organization_id,
        invitation.contact_type === "telegram" ? invitation.contact_value : null,
        invitation.contact_type === "email" ? invitation.contact_value : null,
        input.displayName,
        invitation.role_id,
        invitation.role_code,
      ],
    );

    return result.rows[0];
  }

  private async createSessionForUser(
    client: Queryable,
    user: UserSessionRecord,
    request: { ip?: null | string; userAgent?: null | string },
  ): Promise<{
    expiresAt: string;
    id: string;
    issuedAt: string;
    revokedAt: null;
    token: string;
  }> {
    const id = randomUUID();
    const token = createSessionToken();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + DEFAULT_SESSION_TTL_SECONDS * 1000);

    await client.query(
      `
        INSERT INTO auth_sessions (
          id,
          user_id,
          organization_id,
          token_hash,
          issued_at,
          expires_at,
          revoked_at,
          ip,
          user_agent
        )
        VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, NULL, $7::inet, $8)
      `,
      [
        id,
        user.id,
        user.organizationId,
        hashSessionToken(token),
        issuedAt.toISOString(),
        expiresAt.toISOString(),
        request.ip ?? null,
        request.userAgent ?? null,
      ],
    );

    return {
      expiresAt: expiresAt.toISOString(),
      id,
      issuedAt: issuedAt.toISOString(),
      revokedAt: null,
      token,
    };
  }
}

function normalizeNullableText(value: null | string | undefined): null | string {
  if (value === undefined || value === null) {
    return null;
  }

  return value.trim();
}

function normalizeContact(
  contactType: "email" | "telegram",
  contactValue: string,
): string {
  try {
    return normalizeInvitationContact(contactType, contactValue);
  } catch (error) {
    throw new BadRequestException({
      code: "INVITATION_CONTACT_INVALID",
      description: error instanceof Error ? error.message : "Invitation contact is invalid.",
      humanMessage: "Некорректный контакт приглашения.",
    });
  }
}

function mapOrganization(row: OrganizationRow): OrganizationResponseDto {
  return {
    createdAt: toIso(row.created_at),
    description: row.description,
    id: row.id,
    locale: row.locale,
    name: row.name,
    status: row.status,
    timezone: row.timezone,
    updatedAt: toIso(row.updated_at),
  };
}

function mapInvitation(row: InvitationRow, token: string): InvitationResponseDto {
  return {
    acceptedAt: nullableIso(row.accepted_at),
    contactType: row.contact_type,
    contactValue: row.contact_value,
    createdAt: toIso(row.created_at),
    createdBy: row.created_by,
    expiresAt: toIso(row.expires_at),
    id: row.id,
    organizationId: row.organization_id,
    roleCode: row.role_code,
    token,
  };
}

function sessionResponse(
  user: UserSessionRecord,
  session: {
    expiresAt: string;
    id: string;
    issuedAt: string;
    revokedAt: null;
    token: string;
  },
): Record<string, unknown> {
  const roles = user.roleCodes;

  return {
    authenticated: true,
    expiresAt: session.expiresAt,
    implementationStage: "M4",
    organization: {
      id: user.organizationId,
      name: user.organizationName,
      slug: slugify(user.organizationName),
      status: user.organizationStatus,
    },
    roleBindings: roles.map((role) => ({
      organizationId: user.organizationId,
      role,
    })),
    roles,
    session: {
      expiresAt: session.expiresAt,
      id: session.id,
      issuedAt: session.issuedAt,
      mode: "server",
      revokedAt: session.revokedAt,
    },
    token: session.token,
    user: {
      displayName: user.displayName,
      email: user.email,
      id: user.id,
      organizationId: user.organizationId,
      role: primaryRole(roles),
      status: "active",
      telegramUsername: user.telegramUsername,
    },
  };
}

function hashInvitationToken(token: string): string {
  const secret = process.env[AUTH_HASH_SECRET_ENV] ?? DEFAULT_AUTH_HASH_SECRET;

  return `sha256:${createHmac("sha256", secret)
    .update(`invitation:server:${token}`)
    .digest("hex")}`;
}

function createInvitationToken(): string {
  return `bri_${randomBytes(32).toString("base64url")}`;
}

function createSessionToken(): string {
  return `brs_${randomBytes(32).toString("base64url")}`;
}

function invalidInvitation(description: string): UnauthorizedException {
  return new UnauthorizedException({
    code: "INVITATION_INVALID",
    description,
    humanMessage: "Приглашение недействительно.",
  });
}

function notFound(objectType: string, id: string): NotFoundException {
  return new NotFoundException({
    code: "RESOURCE_NOT_FOUND",
    description: `${objectType} ${id} was not found`,
    humanMessage: "Ресурс не найден.",
  });
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
