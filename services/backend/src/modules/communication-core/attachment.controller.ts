import { Controller, Get, Headers, Param, ParseUUIDPipe, Res, UseGuards, Version } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { Roles } from "../../common/auth/roles.decorator";
import { RolesGuard } from "../../common/auth/roles.guard";
import { SessionAuthGuard } from "../../common/auth/session-auth.guard";
import { getRequiredOrganizationId, ORGANIZATION_ID_HEADER } from "../../common/request-context";
import { AttachmentResolverService } from "./attachment.service";

/**
 * Выдача байтов вложения менеджеру (§4.3). Проксирует поток из Edge (где реально
 * лежат байты) под той же сессией/ролью, что и остальные ручки manager-workspace
 * (`SessionAuthGuard` + `@Roles("manager")`, арендатор — из `x-organization-id`).
 * Менеджер дергает это лениво по `url` из сообщения — не плоским `<a href>`, а
 * через API-клиент (с tenant-заголовком) как blob.
 */
@ApiTags("attachments")
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles("manager")
@Controller("attachments")
export class AttachmentController {
  constructor(private readonly resolver: AttachmentResolverService) {}

  @Get(":id/content")
  @Version("1")
  @ApiOperation({ summary: "Download attachment bytes (proxied from Edge storage)" })
  async downloadContent(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: string | string[] | undefined,
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Res() response: Response,
  ): Promise<void> {
    const organizationId = getRequiredOrganizationId(organizationIdHeader);
    const attachment = await this.resolver.resolve(organizationId, id);

    response.setHeader("content-type", attachment.contentType);
    response.setHeader("content-length", String(attachment.content.byteLength));
    if (attachment.filename) {
      response.setHeader("content-disposition", contentDisposition(attachment.filename));
    }
    response.end(attachment.content);
  }
}

// Content-Disposition c ASCII-фолбэком и RFC 5987 filename* для кириллицы.
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
