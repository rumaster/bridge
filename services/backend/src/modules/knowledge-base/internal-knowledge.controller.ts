import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  VERSION_NEUTRAL,
  Version,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";

import {
  KB_EMBEDDING_DIMENSIONS,
  createKnowledgeSearchResponse,
} from "@bridge/contracts/c3-kb-payloads";
import type { KnowledgeSearchResponse } from "@bridge/contracts/c3-kb-payloads";

import { KnowledgeBaseService } from "./knowledge-base.service";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 100;

/**
 * Внутренний семантический поиск C3.kb для SVC-AI (ТЗ §12.10, мастер-план §7.2).
 *
 * ЭТОГО МАРШРУТА НЕ БЫЛО. Контракт `packages/contracts/src/c3-kb.ts` и клиент
 * `services/ai-platform/src/kb-search.ts` существовали, обработчик — нет, и
 * `git log -S "knowledge:search" -- services/backend` пуст. Из-за этого
 * RAG-ассистент на каждом запросе получал 404 → `KbSearchError` → ловил его и
 * МОЛЧА деградировал до заглушки: `assistant:suggest` всегда отвечал
 * `degraded: true, source_status: "unavailable"`, а документы базы знаний, чьи
 * эмбеддинги Backend исправно писал в `knowledge_chunks`, не читал никто.
 *
 * Почему без токена и без префикса `api`: это service-to-service маршрут доверенной
 * сети — та же схема, что у `internal/ingress/messages` и прочих (см. список
 * `exclude` в `bootstrap.ts`). SVC-AI зовёт его по документированному пути
 * `POST /knowledge:search`, поэтому путь и оставлен ровно таким.
 *
 * Арендатор берётся из тела запроса, а не из заголовка: так задан контракт C3.kb, и
 * изоляцию всё равно обеспечивает RLS в `withTenant`, а не эта строка.
 */
@ApiExcludeController()
@Controller()
export class InternalKnowledgeSearchController {
  constructor(private readonly knowledgeBase: KnowledgeBaseService) {}

  // Двоеточие экранируется: без `\\:` path-to-regexp Express 5 разбирает `:search`
  // как ПАРАМЕТР, и внутренний поиск начинал отвечать на `/knowledge<что угодно>`.
  @Post("knowledge\\:search")
  @Version(VERSION_NEUTRAL)
  // Поиск ничего не создаёт; 201 по умолчанию Nest здесь только путал бы.
  @HttpCode(HttpStatus.OK)
  async search(@Body() body: unknown): Promise<KnowledgeSearchResponse> {
    const request = assertSearchRequest(body);
    const results = await this.knowledgeBase.searchByEmbedding(
      request.organization_id,
      request.embedding,
      request.limit,
    );

    // Ответ собирается ОБЩЕЙ функцией контракта: SVC-AI проверяет его по
    // C3_KB_SEARCH_RESPONSE_SCHEMA и на несоответствие снова уйдёт в тихую
    // деградацию. Сборка руками вернула бы ровно тот дефект, который здесь чинится.
    return createKnowledgeSearchResponse({
      organizationId: request.organization_id,
      results,
    });
  }
}

interface ParsedSearchRequest {
  embedding: number[];
  limit: number;
  organization_id: string;
}

/**
 * Разбор без class-validator: тело — контракт C3.kb, а не DTO админки, и вложенный
 * DTO на вектор из 1536 чисел прогонялся бы через валидатор поэлементно на каждом
 * запросе ассистента.
 */
function assertSearchRequest(body: unknown): ParsedSearchRequest {
  if (body === null || typeof body !== "object") {
    throw badRequest("C3.kb search request must be an object.");
  }

  const payload = body as Record<string, unknown>;
  const organizationId = payload.organization_id;

  if (typeof organizationId !== "string" || organizationId.trim() === "") {
    throw badRequest("C3.kb search request requires organization_id.");
  }

  const embedding = payload.embedding;

  if (
    !Array.isArray(embedding) ||
    embedding.length !== KB_EMBEDDING_DIMENSIONS ||
    !embedding.every((value) => typeof value === "number" && Number.isFinite(value))
  ) {
    throw badRequest(
      `C3.kb search request requires a ${KB_EMBEDDING_DIMENSIONS}-dimension numeric embedding.`,
    );
  }

  return {
    embedding: embedding as number[],
    limit: parseLimit(payload.limit),
    organization_id: organizationId,
  };
}

function parseLimit(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_LIMIT;
  }

  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_LIMIT) {
    throw badRequest(`C3.kb search limit must be an integer between 1 and ${MAX_LIMIT}.`);
  }

  return value as number;
}

function badRequest(description: string): BadRequestException {
  return new BadRequestException({
    code: "KB_SEARCH_REQUEST_INVALID",
    description,
    humanMessage: "Некорректный запрос поиска по базе знаний.",
  });
}
