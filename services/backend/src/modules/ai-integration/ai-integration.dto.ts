import { ApiProperty } from "@nestjs/swagger";
import { IsString, MaxLength, MinLength } from "class-validator";

export class AiAssistantSuggestRequestDto {
  @ApiProperty({
    example: "Как оформить возврат заказа?",
    description: "Вопрос оператора, для которого AI предлагает подсказку.",
  })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  query!: string;
}

export class AiOnboardingCommandRequestDto {
  @ApiProperty({
    example: "Установи часовой пояс Europe/Moscow и локаль ru-RU",
    description: "Свободное описание желаемой настройки для онбординга.",
  })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  prompt!: string;
}
