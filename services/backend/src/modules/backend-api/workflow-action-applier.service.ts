import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";

import { effectiveRoles } from "../../common/auth/auth-context";
import type { RoleCode } from "../../common/auth/auth-context";
import { PgDatabase } from "../../common/database/database.service";
import { validateJsonSchema } from "../../common/json-schema/json-schema-validator";
import { AuditService } from "../audit/audit.service";
import {
  AI_ONBOARDING_COMMAND_SCHEMA,
} from "../ai-integration/ai-onboarding-command.schema";
import type {
  AiOnboardingCommand,
  AiOnboardingCommandAction,
} from "../ai-integration/ai-onboarding-command.schema";
import { ConfigurationService } from "../configuration/configuration.service";
import { OrganizationService } from "../organization/organization.service";

/** Where the change came from — an AI onboarding command or a Workflow node. */
export type ApplyActorType = "ai" | "workflow";

export interface ApplyActionInput {
  /** Raw C4 structured command; validated against the §12.6 schema here. */
  command: unknown;
  organizationId: string;
  actorType: ApplyActorType;
  /** The user on whose behalf the change is applied (recorded in audit). */
  actorUserId?: string;
  /** Effective roles of the *actual* authenticated principal (rights source). */
  roles: RoleCode[];
  requestId?: string;
}

export type AppliedActionStatus = "applied" | "noop" | "not_supported";

export interface AppliedActionResult {
  action: AiOnboardingCommandAction;
  applied: boolean;
  status: AppliedActionStatus;
  detail: Record<string, unknown>;
}

/**
 * The single sanctioned path for applying a change requested by AI onboarding or
 * a Workflow node (ТЗ §5.11, §12.5, §12.6, §13.5). Neither AI nor the Workflow
 * engine may touch the database directly; they produce a *description* (a C4
 * structured command) which the Backend validates against the frozen §12.6
 * schema, authorizes against the current principal's real rights, applies via
 * the owning domain service, and audits with `actor_type = ai | workflow`
 * (ТЗ §22.9).
 */
@Injectable()
export class WorkflowActionApplierService {
  constructor(
    private readonly database: PgDatabase,
    private readonly audit: AuditService,
    private readonly configuration: ConfigurationService,
    private readonly organization: OrganizationService,
  ) {}

  async apply(input: ApplyActionInput): Promise<AppliedActionResult> {
    const command = this.validateCommand(input);

    const isAdministrator = effectiveRoles(input.roles).has("administrator");
    const requiresAdministrator = command.action !== "noop";

    if (requiresAdministrator && !isAdministrator) {
      await this.recordApplyAudit(input, command, "denied", {
        reason: "role_forbidden",
        applied: false,
      });
      throw new ForbiddenException({
        code: "ROLE_FORBIDDEN",
        description: `Applying '${command.action}' requires the administrator role.`,
        humanMessage: "Недостаточно прав для применения действия.",
      });
    }

    const result = await this.applyAction(command, input);

    await this.recordApplyAudit(input, command, "success", {
      applied: result.applied,
      status: result.status,
      ...result.detail,
    });

    return result;
  }

  private validateCommand(input: ApplyActionInput): AiOnboardingCommand {
    const validation = validateJsonSchema(input.command, AI_ONBOARDING_COMMAND_SCHEMA);
    if (!validation.valid) {
      throw new BadRequestException({
        code: "COMMAND_INVALID",
        description: "Structured command failed §12.6 schema validation.",
        humanMessage: "Команда не прошла проверку схемы.",
        diagnostics: { errors: validation.errors },
      });
    }

    const command = input.command as AiOnboardingCommand;

    if (command.organization_id !== input.organizationId) {
      throw new BadRequestException({
        code: "COMMAND_ORG_MISMATCH",
        description: "Command organization_id does not match the request tenant.",
        humanMessage: "Команда относится к другой организации.",
      });
    }

    return command;
  }

  private async applyAction(
    command: AiOnboardingCommand,
    input: ApplyActionInput,
  ): Promise<AppliedActionResult> {
    const mutationContext = {
      actorType: input.actorType,
      actorUserId: input.actorUserId,
      requestId: input.requestId,
    };

    switch (command.action) {
      case "configuration.upsert": {
        const { key, value } = this.extractConfigurationParams(command.params);
        const config = await this.configuration.putConfiguration(
          input.organizationId,
          { key, value },
          mutationContext,
        );
        return {
          action: command.action,
          applied: true,
          status: "applied",
          detail: { key: config.key, version: config.version },
        };
      }

      case "organization.update_profile": {
        const payload = this.extractOrganizationParams(command.params);
        const organization = await this.organization.updateOrganization(
          input.organizationId,
          payload,
          mutationContext,
        );
        return {
          action: command.action,
          applied: true,
          status: "applied",
          detail: { status: organization.status },
        };
      }

      case "channel.connect":
      case "user.invite":
        // These actions require services that arrive in later milestones (M4+);
        // the Backend acknowledges the command without mutating any data.
        return {
          action: command.action,
          applied: false,
          status: "not_supported",
          detail: { reason: "action_not_supported_in_m3" },
        };

      case "noop":
      default:
        return {
          action: command.action,
          applied: false,
          status: "noop",
          detail: {},
        };
    }
  }

  private extractConfigurationParams(params: Record<string, unknown>): {
    key?: string;
    value: Record<string, unknown>;
  } {
    if (!Object.hasOwn(params, "value")) {
      throw this.paramsError("configuration.upsert requires a 'value' parameter.");
    }

    const key = params.key;
    if (key !== undefined && (typeof key !== "string" || key.trim() === "")) {
      throw this.paramsError("configuration.upsert 'key' must be a non-empty string.");
    }

    return {
      key: typeof key === "string" ? key : undefined,
      value: params.value as Record<string, unknown>,
    };
  }

  private extractOrganizationParams(
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    const name = params.name ?? params.display_name;

    if (name !== undefined) {
      payload.name = name;
    }
    for (const field of ["description", "timezone", "locale", "status"] as const) {
      if (Object.hasOwn(params, field)) {
        payload[field] = params[field];
      }
    }

    if (Object.keys(payload).length === 0) {
      throw this.paramsError("organization.update_profile requires at least one profile field.");
    }

    return payload;
  }

  private paramsError(description: string): BadRequestException {
    return new BadRequestException({
      code: "COMMAND_PARAMS_INVALID",
      description,
      humanMessage: "Некорректные параметры команды.",
    });
  }

  private async recordApplyAudit(
    input: ApplyActionInput,
    command: AiOnboardingCommand,
    result: "success" | "denied",
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const action = input.actorType === "ai" ? "ai_onboarding.apply" : "workflow.backend_api_node";
    const objectType =
      input.actorType === "ai" ? "ai_onboarding_command" : "workflow_backend_api_node";

    // `command_id` is a free-form AI-generated string (not a UUID), so it lives
    // in metadata rather than the uuid-typed `object_id` column; the affected
    // object is the tenant organization.
    await this.database.withTenant(input.organizationId, (client) =>
      this.audit.record(client, {
        action,
        actorType: input.actorType,
        actorUserId: input.actorUserId,
        metadata: { command_action: command.action, command_id: command.command_id, ...metadata },
        objectId: input.organizationId,
        objectType,
        organizationId: input.organizationId,
        requestId: input.requestId,
        result,
      }),
    );
  }
}
