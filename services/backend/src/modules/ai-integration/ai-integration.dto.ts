import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsObject, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

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

/**
 * Сырой вызов LLM для узла «LLM» контракта Workflow 2.0 (добавлен 2026-07-15).
 *
 * Отличается от `assistant:suggest` тем, что базы знаний здесь нет: промпт целиком
 * собирает схема, подставляя значения входных портов. Лимит промпта выше, чем у
 * вопроса оператора: узел вправе положить в промпт собранный схемой контекст.
 */
export class AiLlmCompletionRequestDto {
  @ApiProperty({
    example: "Кратко перескажи обращение клиента одним предложением: ...",
    description: "Готовый промпт. Подстановки значений портов делает узел схемы.",
  })
  @IsString()
  @MinLength(1)
  @MaxLength(32000)
  prompt!: string;

  @ApiPropertyOptional({
    example: { temperature: 0.2 },
    description:
      "Параметры генерации. SVC-AI пропускает только белый список (temperature, top_p, max_tokens, stop и т.п.): выбор модели остаётся за платформой.",
  })
  @IsObject()
  @IsOptional()
  params?: Record<string, unknown>;
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
