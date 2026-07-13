import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
  Version,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";

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

  /**
   * Загрузка исходящего вложения (§4.3-bis follow-up п.2): менеджер прикрепляет
   * файл к ответу. Тело — сырые байты (raw body parser в bootstrap), имя файла —
   * заголовок `x-attachment-filename` (URL-encoded для кириллицы), MIME —
   * `content-type`. Backend проксирует байты на RF-том Edge и возвращает
   * непрозрачный `storageRef`, который клиент кладёт в `POST /messages`.
   */
  @Post()
  @Version("1")
  @ApiOperation({ summary: "Upload outgoing attachment bytes (proxied to Edge storage)" })
  async upload(
    @Headers(ORGANIZATION_ID_HEADER) organizationIdHeader: string | string[] | undefined,
    @Req() request: Request,
  ): Promise<{ storageRef: string; name: string; contentType: string | null; sizeBytes: number }> {
    const organizationId = getRequiredOrganizationId(organizationIdHeader);
    const content = request.body;
    if (!Buffer.isBuffer(content) || content.byteLength === 0) {
      throw new BadRequestException({
        code: "VALIDATION_FAILED",
        description: "attachment body must be a non-empty binary payload",
        humanMessage: "Пустой файл нельзя прикрепить.",
      });
    }

    const filename = decodeFilename(request.headers["x-attachment-filename"]);
    const contentTypeHeader = request.headers["content-type"];
    const mime =
      typeof contentTypeHeader === "string" && contentTypeHeader !== "application/octet-stream"
        ? contentTypeHeader
        : undefined;

    const stored = await this.resolver.store(organizationId, {
      content,
      ...(filename ? { filename } : {}),
      ...(mime ? { mime } : {}),
    });

    return {
      storageRef: stored.storageRef,
      name: filename ?? "attachment",
      contentType: mime ?? null,
      sizeBytes: stored.size,
    };
  }

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

/** Декодирует имя файла из заголовка (URL-encoded для не-ASCII). */
function decodeFilename(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string" || raw.trim() === "") {
    return undefined;
  }
  try {
    const decoded = decodeURIComponent(raw).trim();
    return decoded === "" ? undefined : decoded;
  } catch {
    return raw.trim();
  }
}

// Content-Disposition c ASCII-фолбэком и RFC 5987 filename* для кириллицы.
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
