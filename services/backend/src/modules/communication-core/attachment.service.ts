import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";

import { PgDatabase } from "../../common/database/database.service";

/**
 * Резолв байтов вложения на выдаче (§4.3 плана
 * `docs/plan/email-channel-production.md`). Менеджер (App-сторона) скачивает
 * вложение ЛЕНИВО через backend-прокси `GET /v1/attachments/:id/content` —
 * только когда открывает его в manager-workspace.
 *
 * Байты физически лежат на Edge (RF, резидентность ПДн, 152-ФЗ). Backend НЕ
 * хранит байты и НЕ парсит `storage_ref` (непрозрачная строка): по id вложения
 * (под RLS арендатора) достаёт сохранённый `storage_ref` и проксирует поток из
 * Edge (`GET /internal/edge/attachments?ref=…`). Так «не тащим байты за рубеж
 * без нужды» — только по запросу конкретного менеджера.
 */

export interface ResolvedAttachment {
  content: Buffer;
  contentType: string;
  filename?: string;
}

interface AttachmentRow {
  storage_ref: string;
  mime: string | null;
  metadata: Record<string, unknown> | null;
}

@Injectable()
export class AttachmentResolverService {
  private readonly logger = new Logger(AttachmentResolverService.name);

  constructor(private readonly database: PgDatabase) {}

  async resolve(organizationId: string, attachmentId: string): Promise<ResolvedAttachment> {
    const row = await this.database.withTenant(organizationId, async (client) => {
      const result = await client.query<AttachmentRow>(
        `
          SELECT storage_ref, mime, metadata
          FROM attachments
          WHERE organization_id = $1 AND id = $2
        `,
        [organizationId, attachmentId],
      );
      return result.rowCount && result.rowCount > 0 ? result.rows[0] : null;
    });

    if (!row) {
      throw new NotFoundException({
        code: "RESOURCE_NOT_FOUND",
        description: `attachment ${attachmentId} was not found`,
        humanMessage: "Вложение не найдено.",
      });
    }

    const edgeUrl = this.edgeAttachmentUrl();
    if (!edgeUrl) {
      // Нет резолвера Edge — честно сообщаем, а не отдаём пустое тело.
      this.logger.warn(
        `EDGE_ATTACHMENT_URL/EDGE_CONTROL_URL не заданы — вложение ${attachmentId} не резолвится`,
      );
      throw new ServiceUnavailableException({
        code: "ATTACHMENT_STORAGE_UNAVAILABLE",
        description: "attachment storage resolver is not configured",
        humanMessage: "Хранилище вложений недоступно.",
      });
    }

    const target = `${edgeUrl}?ref=${encodeURIComponent(row.storage_ref)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs());
    let response: Response;
    try {
      const token = process.env.EDGE_CONTROL_TOKEN;
      response = await fetch(target, {
        signal: controller.signal,
        headers: token && token.trim() !== "" ? { authorization: `Bearer ${token.trim()}` } : {},
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Не удалось получить вложение ${attachmentId} с Edge: ${reason}`);
      throw new ServiceUnavailableException({
        code: "ATTACHMENT_FETCH_FAILED",
        description: `edge attachment fetch failed: ${reason}`,
        humanMessage: "Не удалось загрузить вложение.",
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 404) {
      // Метаданные есть, а байтов на Edge нет (напр. oversized — сохранена только
      // запись без байтов, или байты удалены). Отдаём 404, а не 5xx.
      throw new NotFoundException({
        code: "RESOURCE_NOT_FOUND",
        description: `attachment ${attachmentId} bytes are not available`,
        humanMessage: "Байты вложения недоступны.",
      });
    }
    if (!response.ok) {
      throw new ServiceUnavailableException({
        code: "ATTACHMENT_FETCH_FAILED",
        description: `edge returned HTTP ${response.status}`,
        humanMessage: "Не удалось загрузить вложение.",
      });
    }

    const content = Buffer.from(await response.arrayBuffer());
    const contentType =
      response.headers.get("content-type") ??
      (typeof row.mime === "string" && row.mime !== "" ? row.mime : "application/octet-stream");
    const filename = this.filenameOf(row.metadata);
    return { content, contentType, filename };
  }

  /**
   * URL резолва вложения на Edge. Явный `EDGE_ATTACHMENT_URL` или, если не задан,
   * выводится из `EDGE_CONTROL_URL` (тот же Edge-хост, путь
   * `/internal/edge/attachments`).
   */
  private edgeAttachmentUrl(): string | null {
    const explicit = process.env.EDGE_ATTACHMENT_URL?.trim();
    if (explicit) {
      return explicit;
    }
    const controlUrl = process.env.EDGE_CONTROL_URL?.trim();
    if (!controlUrl) {
      return null;
    }
    if (controlUrl.includes("/internal/edge/control/messages")) {
      return controlUrl.replace("/internal/edge/control/messages", "/internal/edge/attachments");
    }
    return null;
  }

  private filenameOf(metadata: Record<string, unknown> | null): string | undefined {
    const filename = (metadata ?? {}).filename;
    return typeof filename === "string" && filename.trim() !== "" ? filename : undefined;
  }

  private timeoutMs(): number {
    const raw = Number(process.env.EDGE_ATTACHMENT_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 20_000;
  }
}
