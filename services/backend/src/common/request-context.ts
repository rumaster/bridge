import { BadRequestException } from "@nestjs/common";

export const ACTOR_USER_ID_HEADER = "x-actor-user-id";
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
export const ORGANIZATION_ID_HEADER = "x-organization-id";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type HeaderValue = string | string[] | undefined;

export function getRequiredOrganizationId(headerValue: HeaderValue): string {
  const organizationId = firstHeader(headerValue);
  if (!organizationId || !UUID_V4_PATTERN.test(organizationId)) {
    throw new BadRequestException({
      code: "TENANT_REQUIRED",
      description: `${ORGANIZATION_ID_HEADER} header must be an RFC 4122 v4 UUID`,
      humanMessage: "Не указан корректный идентификатор организации.",
    });
  }

  return organizationId;
}

export function getOptionalActorUserId(headerValue: HeaderValue): string | undefined {
  const actorUserId = firstHeader(headerValue);
  if (!actorUserId) {
    return undefined;
  }

  if (!UUID_V4_PATTERN.test(actorUserId)) {
    throw new BadRequestException({
      code: "ACTOR_INVALID",
      description: `${ACTOR_USER_ID_HEADER} header must be an RFC 4122 v4 UUID`,
      humanMessage: "Некорректный идентификатор пользователя.",
    });
  }

  return actorUserId;
}

export function isUuidV4(value: string): boolean {
  return UUID_V4_PATTERN.test(value);
}

function firstHeader(value: HeaderValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
