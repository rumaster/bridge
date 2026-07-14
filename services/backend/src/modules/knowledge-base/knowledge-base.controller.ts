import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
  Version,
} from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { Roles } from "../../common/auth/roles.decorator";
import { RolesGuard } from "../../common/auth/roles.guard";
import { SessionAuthGuard } from "../../common/auth/session-auth.guard";
import { getRequiredOrganizationId, ORGANIZATION_ID_HEADER } from "../../common/request-context";
import type { HeaderValue } from "../../common/request-context";
import {
  CreateKnowledgeDocumentDto,
  DeleteKnowledgeDocumentResponseDto,
  KnowledgeDocumentResponseDto,
  UpdateKnowledgeDocumentDto,
} from "./knowledge-base.dto";
import { KnowledgeBaseService } from "./knowledge-base.service";

@ApiTags("knowledge")
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles("administrator")
@Controller("knowledge/documents")
export class KnowledgeBaseController {
  constructor(private readonly knowledgeBase: KnowledgeBaseService) {}

  @Get()
  @Version("1")
  @ApiOperation({ summary: "List Knowledge Base documents in tenant scope" })
  @ApiOkResponse({ type: KnowledgeDocumentResponseDto, isArray: true })
  listDocuments(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
  ): Promise<KnowledgeDocumentResponseDto[]> {
    return this.knowledgeBase.listDocuments(getRequiredOrganizationId(organizationIdHeader));
  }

  @Post()
  @Version("1")
  @ApiOperation({ summary: "Create a Knowledge Base document and embed its content" })
  @ApiCreatedResponse({ type: KnowledgeDocumentResponseDto })
  createDocument(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Body() body: CreateKnowledgeDocumentDto,
  ): Promise<KnowledgeDocumentResponseDto> {
    return this.knowledgeBase.createDocument(getRequiredOrganizationId(organizationIdHeader), body);
  }

  @Patch(":id")
  @Version("1")
  @ApiOperation({ summary: "Update a Knowledge Base document" })
  @ApiOkResponse({ type: KnowledgeDocumentResponseDto })
  updateDocument(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Param("id", new ParseUUIDPipe({ version: "4" })) documentId: string,
    @Body() body: UpdateKnowledgeDocumentDto,
  ): Promise<KnowledgeDocumentResponseDto> {
    return this.knowledgeBase.updateDocument(
      getRequiredOrganizationId(organizationIdHeader),
      documentId,
      body,
    );
  }

  @Delete(":id")
  @Version("1")
  @ApiOperation({ summary: "Delete a Knowledge Base document" })
  @ApiOkResponse({ type: DeleteKnowledgeDocumentResponseDto })
  deleteDocument(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: HeaderValue,
    @Param("id", new ParseUUIDPipe({ version: "4" })) documentId: string,
  ): Promise<DeleteKnowledgeDocumentResponseDto> {
    return this.knowledgeBase.deleteDocument(
      getRequiredOrganizationId(organizationIdHeader),
      documentId,
    );
  }
}
