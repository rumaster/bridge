import { Body, Controller, Headers, HttpCode, HttpStatus, Post, UseGuards, Version } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { Roles } from "../../common/auth/roles.decorator";
import { RolesGuard } from "../../common/auth/roles.guard";
import { SessionAuthGuard } from "../../common/auth/session-auth.guard";
import { getRequiredOrganizationId, ORGANIZATION_ID_HEADER } from "../../common/request-context";
import type { HeaderValue } from "../../common/request-context";
import {
  KnowledgeSearchResponseDto,
  SearchKnowledgeDocumentsDto,
} from "./knowledge-base.dto";
import { KnowledgeBaseService } from "./knowledge-base.service";

const DEFAULT_TOP_K = 5;

/**
 * Поиск по базе знаний для узла «Поиск в Knowledge Base» (контракт Workflow 2.0).
 *
 * Отдельный контроллер, а не метод `KnowledgeBaseController`: тот держит CRUD под
 * префиксом `knowledge/documents`, а здесь нужен глагол `knowledge/documents:search`
 * — конвенция платформы для действий (ср. `ai/assistant:suggest`).
 *
 * Почему поиск живёт в Backend, а не в SVC-AI: Backend владеет и чанками
 * (`knowledge_chunks`, pgvector под RLS), и моделью эмбеддингов, которой считает
 * векторы документов при сохранении. Гонять запрос через SVC-AI значило бы уйти по
 * gRPC и вернуться в Backend же за pgvector — петля за данными, которые уже под
 * рукой. Инвариант «модель и размерность у документов и запросов совпадают»
 * (CLAUDE.md) при этом соблюдается по построению: обе стороны — один сервис.
 */
@ApiTags("knowledge")
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles("administrator")
@Controller("knowledge")
export class KnowledgeSearchController {
  constructor(private readonly knowledgeBase: KnowledgeBaseService) {}

  // Двоеточие экранируется: без `\\:` path-to-regexp Express 5 разбирает `:search`
  // как ПАРАМЕТР, и маршрут начинает матчить `/knowledge/documents<что угодно>`.
  @Post("documents\\:search")
  @Version("1")
  // POST здесь — из-за тела запроса (ключевые фразы), а не потому что что-то
  // создаётся: 201 по умолчанию Nest вводил бы в заблуждение.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Search Knowledge Base documents by key phrases and tags" })
  @ApiOkResponse({ type: KnowledgeSearchResponseDto })
  async searchDocuments(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Body() body: SearchKnowledgeDocumentsDto,
  ): Promise<KnowledgeSearchResponseDto> {
    const documents = await this.knowledgeBase.searchByKeys(
      getRequiredOrganizationId(organizationIdHeader),
      body.keys,
      body.tags ?? [],
      body.top_k ?? DEFAULT_TOP_K,
    );

    return { documents };
  }
}
