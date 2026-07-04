import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

const NOTIFICATION_CATEGORIES = ["info", "warning", "error", "critical", "admin"] as const;
const NOTIFICATION_CHANNELS = ["web", "telegram", "email", "push"] as const;
const NOTIFICATION_STATUSES = ["new", "read"] as const;

export class ListNotificationsQueryDto {
  @ApiPropertyOptional({ enum: NOTIFICATION_STATUSES, example: "new" })
  @IsOptional()
  @IsIn(NOTIFICATION_STATUSES)
  status?: "new" | "read";

  @ApiPropertyOptional({ enum: NOTIFICATION_CATEGORIES, example: "critical" })
  @IsOptional()
  @IsIn(NOTIFICATION_CATEGORIES)
  category?: "info" | "warning" | "error" | "critical" | "admin";

  @ApiPropertyOptional({ example: "cursor-1" })
  @IsOptional()
  @IsString()
  @MinLength(1)
  cursor?: string;

  @ApiPropertyOptional({ example: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class NotificationSettingDto {
  @ApiProperty({ enum: NOTIFICATION_CATEGORIES, example: "critical" })
  @IsIn(NOTIFICATION_CATEGORIES)
  category!: "info" | "warning" | "error" | "critical" | "admin";

  @ApiProperty({ enum: NOTIFICATION_CHANNELS, example: "telegram" })
  @IsIn(NOTIFICATION_CHANNELS)
  channel!: "web" | "telegram" | "email" | "push";

  @ApiProperty({ example: true })
  @IsBoolean()
  enabled!: boolean;
}

export class UpdateNotificationSettingsRequestDto {
  @ApiProperty({ type: [NotificationSettingDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => NotificationSettingDto)
  settings!: NotificationSettingDto[];
}
