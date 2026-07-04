import { Type } from "class-transformer";
import {
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

const BROADCAST_TEMPLATE_TYPES = ["text"] as const;
const BROADCAST_FILTER_MODES = ["all", "tags", "segment", "custom"] as const;
const BROADCAST_SCHEDULE_MODES = ["manual", "immediate", "scheduled", "event", "workflow"] as const;
const BROADCAST_START_MODES = ["immediate", "scheduled"] as const;
const RATE_LIMIT_STRATEGIES = ["fixed", "channel_capability"] as const;

export class BroadcastTemplateDto {
  @ApiProperty({ enum: BROADCAST_TEMPLATE_TYPES, example: "text" })
  @IsIn(BROADCAST_TEMPLATE_TYPES)
  type!: "text";

  @ApiProperty({ example: "Здравствуйте, {{client.name}}" })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;

  @ApiPropertyOptional({ example: "ru-RU" })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  locale?: string;

  @ApiPropertyOptional({ example: ["client.name"], type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  variables?: string[];
}

export class BroadcastFilterDto {
  @ApiProperty({ enum: BROADCAST_FILTER_MODES, example: "all" })
  @IsIn(BROADCAST_FILTER_MODES)
  mode!: "all" | "tags" | "segment" | "custom";

  @ApiPropertyOptional({ example: ["web_chat"], type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  channels?: string[];

  @ApiPropertyOptional({ example: ["vip"], type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ example: ["segment-a"], type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  segment_ids?: string[];

  @ApiPropertyOptional({ additionalProperties: true, type: Object })
  @IsOptional()
  @IsObject()
  criteria?: Record<string, unknown>;
}

export class BroadcastScheduleDto {
  @ApiProperty({ enum: BROADCAST_SCHEDULE_MODES, example: "manual" })
  @IsIn(BROADCAST_SCHEDULE_MODES)
  mode!: "manual" | "immediate" | "scheduled" | "event" | "workflow";

  @ApiPropertyOptional({ example: "2026-07-04T12:00:00.000Z" })
  @ValidateIf((dto: BroadcastScheduleDto) => dto.mode === "scheduled" || dto.scheduled_for !== undefined)
  @IsDefined()
  @IsISO8601({ strict: true })
  scheduled_for?: string;

  @ApiPropertyOptional({ example: "Europe/Moscow" })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({ example: "workflow.completed" })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  trigger?: string;
}

export class BroadcastRateLimitDto {
  @ApiProperty({ example: 120, minimum: 1 })
  @IsInt()
  @Min(1)
  messages_per_minute!: number;

  @ApiPropertyOptional({ example: 20, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  burst?: number;

  @ApiPropertyOptional({ enum: RATE_LIMIT_STRATEGIES, example: "fixed" })
  @IsOptional()
  @IsIn(RATE_LIMIT_STRATEGIES)
  strategy?: "fixed" | "channel_capability";
}

export class CreateBroadcastRequestDto {
  @ApiProperty({ example: "Июльская рассылка" })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @ApiProperty({ type: BroadcastTemplateDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => BroadcastTemplateDto)
  template!: BroadcastTemplateDto;

  @ApiProperty({ type: BroadcastFilterDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => BroadcastFilterDto)
  filter!: BroadcastFilterDto;

  @ApiProperty({ type: BroadcastScheduleDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => BroadcastScheduleDto)
  schedule!: BroadcastScheduleDto;

  @ApiProperty({ type: BroadcastRateLimitDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => BroadcastRateLimitDto)
  rate_limit!: BroadcastRateLimitDto;
}

export class StartBroadcastRequestDto {
  @ApiProperty({ enum: BROADCAST_START_MODES, example: "immediate" })
  @IsIn(BROADCAST_START_MODES)
  mode!: "immediate" | "scheduled";

  @ApiPropertyOptional({ example: "2026-07-04T12:00:00.000Z" })
  @ValidateIf((dto: StartBroadcastRequestDto) => dto.mode === "scheduled" || dto.scheduled_for !== undefined)
  @IsDefined()
  @IsISO8601({ strict: true })
  scheduled_for?: string;
}

export class ListBroadcastsQueryDto {
  @ApiPropertyOptional({ example: 50, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
