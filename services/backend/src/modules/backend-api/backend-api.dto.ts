import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from "class-validator";

export type WorkflowTrigger = "manual" | "message" | "system" | "workflow";

export class WorkflowNodeContextDto {
  @ApiProperty({ example: "00000000-0000-4000-8000-000000000101" })
  @IsString()
  @Matches(/\S/)
  organization_id!: string;

  @ApiProperty({ example: "00000000-0000-4000-8000-000000000201" })
  @IsString()
  @Matches(/\S/)
  actor_user_id!: string;

  @ApiProperty({ enum: ["manual", "message", "system", "workflow"], example: "workflow" })
  @IsIn(["manual", "message", "system", "workflow"])
  trigger!: WorkflowTrigger;

  @ApiProperty({ example: ["administrator"], required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roles?: string[];
}

/**
 * Backend API node invocation (C5, ТЗ §13.5): SVC-FBP forwards a Workflow node
 * request carrying the acting user's execution context and the structured
 * command to apply. The Backend authorizes the *real* authenticated principal,
 * applies the change and returns the result — the only sanctioned way a Workflow
 * changes data.
 */
export class BackendApiNodeInvokeDto {
  @ApiProperty({ example: "00000000-0000-4000-8000-000000000401" })
  @IsString()
  @Matches(/\S/)
  workflow_id!: string;

  @ApiProperty({ example: "00000000-0000-4000-8000-000000000402" })
  @IsString()
  @Matches(/\S/)
  workflow_version_id!: string;

  @ApiProperty({ example: "00000000-0000-4000-8000-000000000403" })
  @IsString()
  @Matches(/\S/)
  instance_id!: string;

  @ApiProperty({ example: "apply-configuration" })
  @IsString()
  @Matches(/\S/)
  node_id!: string;

  @ApiProperty({ type: WorkflowNodeContextDto })
  @ValidateNested()
  @Type(() => WorkflowNodeContextDto)
  context!: WorkflowNodeContextDto;

  @ApiProperty({ type: Object, description: "C4 structured command to apply (validated §12.6)." })
  @IsObject()
  command!: Record<string, unknown>;
}

/** AI Onboarding apply: a structured C4 command an administrator confirms. */
export class OnboardingApplyDto {
  @ApiProperty({ type: Object, description: "C4 structured command produced by SVC-AI." })
  @IsObject()
  command!: Record<string, unknown>;
}
