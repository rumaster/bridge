import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsIn, IsObject, IsOptional, IsUUID } from "class-validator";

export const WORKFLOW_STATUSES = ["draft", "active", "archived"] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const WORKFLOW_NODE_TYPES = [
  "backend-api",
  "llm",
  "knowledge-base-search",
  "branch",
  "transform",
  "sub_schema",
  "wait-event",
] as const;
export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];

export const WORKFLOW_SUBSCHEMA_STATUSES = ["draft", "active"] as const;
export type WorkflowSubschemaStatus = (typeof WORKFLOW_SUBSCHEMA_STATUSES)[number];

export type WorkflowInstanceStatus =
  | "callback_recorded"
  | "cancelled"
  | "completed"
  | "created"
  | "degraded"
  | "failed"
  | "running"
  | "started"
  | "waiting";

export class CreateWorkflowVersionDto {
  @ApiProperty({ type: Object })
  @IsObject()
  schema!: Record<string, unknown>;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  activate?: boolean;
}

export class UpdateWorkflowDto {
  @ApiPropertyOptional({ example: true })
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @ApiPropertyOptional({ enum: WORKFLOW_STATUSES, example: "active" })
  @IsIn(WORKFLOW_STATUSES)
  @IsOptional()
  status?: WorkflowStatus;

  @ApiPropertyOptional({ example: "30000000-0000-4000-8000-000000000811" })
  @IsUUID("4")
  @IsOptional()
  default_version_id?: string;
}

export class WorkflowResponseDto {
  @ApiProperty({ example: "30000000-0000-4000-8000-000000000801" })
  id!: string;

  @ApiProperty({ example: "30000000-0000-4000-8000-000000000101" })
  organization_id!: string;

  @ApiProperty({ example: "Распределение обращений" })
  name!: string;

  @ApiProperty({ example: "" })
  description!: string;

  @ApiProperty({ enum: WORKFLOW_STATUSES, example: "active" })
  status!: WorkflowStatus;

  @ApiProperty({ example: true })
  enabled!: boolean;

  @ApiProperty({ example: "30000000-0000-4000-8000-000000000811" })
  default_version_id!: string;

  @ApiProperty({ example: "2026-07-04T10:03:00.000Z" })
  created_at!: string;

  @ApiProperty({ example: "2026-07-04T10:04:00.000Z" })
  updated_at!: string;
}

export class WorkflowVersionResponseDto {
  @ApiProperty({ example: "30000000-0000-4000-8000-000000000811" })
  id!: string;

  @ApiProperty({ example: "30000000-0000-4000-8000-000000000101" })
  organization_id!: string;

  @ApiProperty({ example: "30000000-0000-4000-8000-000000000801" })
  workflow_id!: string;

  @ApiProperty({ example: 1 })
  version_no!: number;

  @ApiProperty({ type: Object })
  schema!: Record<string, unknown>;

  @ApiProperty({ example: "30000000-0000-4000-8000-000000000201" })
  created_by!: string;

  @ApiProperty({ example: "2026-07-04T10:04:00.000Z" })
  created_at!: string;
}

export class WorkflowSubschemaResponseDto {
  @ApiProperty({ example: "30000000-0000-4000-8000-000000000841" })
  id!: string;

  @ApiProperty({ example: "30000000-0000-4000-8000-000000000101" })
  organization_id!: string;

  @ApiProperty({ example: "support-common-context" })
  slug!: string;

  @ApiProperty({ example: "Общий контекст поддержки" })
  name!: string;

  @ApiProperty({ type: Object })
  schema!: Record<string, unknown>;

  @ApiProperty({ enum: WORKFLOW_SUBSCHEMA_STATUSES, example: "active" })
  status!: WorkflowSubschemaStatus;

  @ApiProperty({ example: "2026-07-08T12:00:00.000Z" })
  created_at!: string;

  @ApiProperty({ example: "2026-07-08T12:00:00.000Z" })
  updated_at!: string;
}

export class WorkflowInstanceResponseDto {
  @ApiProperty({ example: "30000000-0000-4000-8000-000000000821" })
  id!: string;

  @ApiProperty({ example: "30000000-0000-4000-8000-000000000101" })
  organization_id!: string;

  @ApiProperty({ example: "30000000-0000-4000-8000-000000000801" })
  workflow_id!: string;

  @ApiProperty({ example: "30000000-0000-4000-8000-000000000811" })
  workflow_version_id!: string;

  @ApiProperty({ example: 1 })
  version_no!: number;

  @ApiProperty({ example: "running" })
  status!: WorkflowInstanceStatus;

  @ApiPropertyOptional({ nullable: true })
  started_at!: null | string;

  @ApiPropertyOptional({ nullable: true })
  finished_at!: null | string;

  @ApiProperty({ example: "2026-07-04T10:05:00.000Z" })
  created_at!: string;
}

export class WorkflowInstanceLogEntryDto {
  @ApiProperty({ example: "30000000-0000-4000-8000-000000000831" })
  id!: string;

  @ApiPropertyOptional({ nullable: true })
  node_id!: null | string;

  @ApiPropertyOptional({ enum: WORKFLOW_NODE_TYPES })
  node_type?: WorkflowNodeType;

  @ApiProperty({ example: "node.started" })
  event!: string;

  @ApiProperty({ example: "Node started" })
  message!: string;

  @ApiProperty({ example: "2026-07-04T10:05:00.000Z" })
  created_at!: string;
}

export class WorkflowInstanceDetailResponseDto extends WorkflowInstanceResponseDto {
  @ApiProperty({ type: [WorkflowInstanceLogEntryDto] })
  logs!: WorkflowInstanceLogEntryDto[];
}

export interface WorkflowRow {
  created_at: Date | string;
  default_version_id: null | string;
  id: string;
  name: string;
  organization_id: string;
  status: WorkflowStatus;
  updated_at: Date | string;
}

export interface WorkflowVersionRow {
  created_at: Date | string;
  created_by: null | string;
  id: string;
  organization_id: string;
  schema: Record<string, unknown>;
  version_no: number | string;
  workflow_id: string;
}

export interface WorkflowSubschemaRow {
  created_at: Date | string;
  id: string;
  name: string;
  organization_id: string;
  schema: Record<string, unknown>;
  slug: string;
  status: WorkflowSubschemaStatus;
  updated_at: Date | string;
}

export interface WorkflowInstanceRow {
  created_at: Date | string;
  finished_at: Date | null | string;
  id: string;
  organization_id: string;
  started_at: Date | null | string;
  status: string;
  version_id: string;
  version_no: number | string;
  workflow_id: string;
}

export interface WorkflowInstanceLogRow {
  created_at: Date | string;
  data: Record<string, unknown>;
  event: string;
  id: string;
  node_id: null | string;
}

export function mapWorkflow(row: WorkflowRow): WorkflowResponseDto {
  return {
    created_at: toIso(row.created_at),
    default_version_id: row.default_version_id ?? "",
    description: "",
    enabled: row.status !== "archived",
    id: row.id,
    name: row.name,
    organization_id: row.organization_id,
    status: row.status,
    updated_at: toIso(row.updated_at),
  };
}

export function mapWorkflowVersion(row: WorkflowVersionRow): WorkflowVersionResponseDto {
  return {
    created_at: toIso(row.created_at),
    created_by: row.created_by ?? "",
    id: row.id,
    organization_id: row.organization_id,
    schema: row.schema,
    version_no: Number(row.version_no),
    workflow_id: row.workflow_id,
  };
}

export function mapWorkflowSubschema(row: WorkflowSubschemaRow): WorkflowSubschemaResponseDto {
  return {
    created_at: toIso(row.created_at),
    id: row.id,
    name: row.name,
    organization_id: row.organization_id,
    schema: row.schema,
    slug: row.slug,
    status: row.status,
    updated_at: toIso(row.updated_at),
  };
}

export function mapWorkflowInstance(row: WorkflowInstanceRow): WorkflowInstanceResponseDto {
  return {
    created_at: toIso(row.created_at),
    finished_at: nullableIso(row.finished_at),
    id: row.id,
    organization_id: row.organization_id,
    started_at: nullableIso(row.started_at),
    status: mapInstanceStatus(row.status),
    version_no: Number(row.version_no),
    workflow_id: row.workflow_id,
    workflow_version_id: row.version_id,
  };
}

export function mapWorkflowLog(row: WorkflowInstanceLogRow): WorkflowInstanceLogEntryDto {
  return {
    created_at: toIso(row.created_at),
    event: row.event,
    id: row.id,
    message: typeof row.data.message === "string" ? row.data.message : row.event,
    node_id: row.node_id,
    node_type: isWorkflowNodeType(row.data.node_type) ? row.data.node_type : undefined,
  };
}

function mapInstanceStatus(status: string): WorkflowInstanceStatus {
  return status === "pending" ? "created" : (status as WorkflowInstanceStatus);
}

function isWorkflowNodeType(value: unknown): value is WorkflowNodeType {
  return typeof value === "string" && (WORKFLOW_NODE_TYPES as readonly string[]).includes(value);
}

function nullableIso(value: Date | null | string): null | string {
  return value === null ? null : toIso(value);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
