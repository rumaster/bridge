/**
 * Canonical C4 AI Onboarding structured command (ТЗ §12.6). The schema and
 * action list are embedded here — rather than read from the ESM-only
 * `@bridge/contracts` package — because the backend compiles to CommonJS and
 * cannot statically import the TypeScript contract sources at runtime. The
 * `json-schema-drift.spec.ts` test asserts this embedded copy stays byte-for-byte
 * equal to `packages/contracts/json-schema/c4-ai-onboarding-command.schema.json`,
 * so any contract change fails the build until this copy is updated.
 */

import type { JsonSchema } from "../../common/json-schema/json-schema-validator";

export const AI_ONBOARDING_COMMAND_ACTIONS = [
  "organization.update_profile",
  "configuration.upsert",
  "channel.connect",
  "user.invite",
  "noop",
] as const;

export type AiOnboardingCommandAction = (typeof AI_ONBOARDING_COMMAND_ACTIONS)[number];

export interface AiOnboardingCommand {
  contract: "C4.AiOnboardingCommand";
  version: "1.0.0";
  command_id: string;
  organization_id: string;
  action: AiOnboardingCommandAction;
  params: Record<string, unknown>;
  safety: {
    apply_mode: "backend_validation_required";
    requires_confirmation: boolean;
    notes: string[];
  };
  source: {
    prompt: string;
    generated_by: string;
  };
  created_at: string;
}

export const AI_ONBOARDING_COMMAND_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://contracts.bridge.local/c4-ai-onboarding-command.schema.json",
  title: "C4 AI Onboarding Structured Command",
  description:
    "M0 structured command produced by SVC-AI and applied only by Backend after validation and authorization checks.",
  type: "object",
  additionalProperties: false,
  required: [
    "contract",
    "version",
    "command_id",
    "organization_id",
    "action",
    "params",
    "safety",
    "source",
    "created_at",
  ],
  properties: {
    contract: {
      const: "C4.AiOnboardingCommand",
    },
    version: {
      const: "1.0.0",
    },
    command_id: {
      type: "string",
      minLength: 1,
    },
    organization_id: {
      type: "string",
      minLength: 1,
    },
    action: {
      type: "string",
      enum: [
        "organization.update_profile",
        "configuration.upsert",
        "channel.connect",
        "user.invite",
        "noop",
      ],
    },
    params: {
      type: "object",
      additionalProperties: true,
    },
    safety: {
      type: "object",
      additionalProperties: false,
      required: ["apply_mode", "requires_confirmation", "notes"],
      properties: {
        apply_mode: {
          const: "backend_validation_required",
        },
        requires_confirmation: {
          type: "boolean",
        },
        notes: {
          type: "array",
          items: {
            type: "string",
            minLength: 1,
          },
        },
      },
    },
    source: {
      type: "object",
      additionalProperties: false,
      required: ["prompt", "generated_by"],
      properties: {
        prompt: {
          type: "string",
          minLength: 1,
        },
        generated_by: {
          type: "string",
          enum: ["deterministic-mock-ai", "fallback"],
        },
      },
    },
    created_at: {
      type: "string",
      format: "date-time",
    },
  },
};
