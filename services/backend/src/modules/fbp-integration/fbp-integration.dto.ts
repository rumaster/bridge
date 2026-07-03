import { ApiProperty } from "@nestjs/swagger";
import { IsObject, IsOptional, IsString, Matches } from "class-validator";

/**
 * Start a Workflow instance (C5, ТЗ §6.13). The initiator is always the Backend
 * on behalf of the acting user — never the AI directly — so the acting user is
 * carried explicitly and the tenant comes from the request header.
 */
export class StartWorkflowRequestDto {
  @ApiProperty({ example: "00000000-0000-4000-8000-000000000402" })
  @IsString()
  @Matches(/\S/)
  workflow_version_id!: string;

  @ApiProperty({ example: "00000000-0000-4000-8000-000000000201" })
  @IsString()
  @Matches(/\S/)
  actor_user_id!: string;

  @ApiProperty({
    type: Object,
    required: false,
    description: "Optional Workflow input payload.",
  })
  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;
}
