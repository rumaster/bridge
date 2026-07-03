import { randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";

import type { Queryable } from "../../common/database/database.service";

export type AuditActorType = "ai" | "system" | "user" | "workflow";
export type AuditResult = "denied" | "failure" | "success";

export interface AuditEventInput {
  action: string;
  actorType?: AuditActorType;
  actorUserId?: string;
  metadata?: Record<string, unknown>;
  objectId?: string;
  objectType: string;
  organizationId: string;
  requestId?: string;
  result?: AuditResult;
}

@Injectable()
export class AuditService {
  async record(queryable: Queryable, input: AuditEventInput): Promise<void> {
    await queryable.query(
      `
        INSERT INTO audit_events (
          id,
          organization_id,
          actor_user_id,
          actor_type,
          action,
          object_type,
          object_id,
          result,
          request_id,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      `,
      [
        randomUUID(),
        input.organizationId,
        input.actorUserId ?? null,
        input.actorType ?? "user",
        input.action,
        input.objectType,
        input.objectId ?? null,
        input.result ?? "success",
        input.requestId ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  }
}
