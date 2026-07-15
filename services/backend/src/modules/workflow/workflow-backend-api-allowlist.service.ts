import { BadRequestException, Injectable } from "@nestjs/common";

import { BACKEND_API_OPERATIONS, isBackendApiOperationId } from "@bridge/contracts/backend-api-catalog";

import { PgDatabase } from "../../common/database/database.service";
import { BackendApiAllowlistEntryDto } from "./workflow.dto";

interface AllowlistRow {
  operation_id: string;
  enabled: boolean;
  curated_by: string | null;
  curated_at: Date;
  note: string | null;
}

/**
 * Витрина вызовов Backend API для узла «Вызов Backend API» (решение A3).
 *
 * Каталог из 79 операций генерируется из OpenAPI и живёт в коде — он отвечает,
 * «что вообще существует». Витрина отвечает на другой вопрос: «что оператору
 * разрешено дёргать из схемы». Разделение осознанное: каталог едет за API сам,
 * а разрешение — решение человека, потому что backend-api — единственный узел,
 * меняющий данные (ТЗ §13.5).
 *
 * Список всегда строится ОТ каталога, а не от таблицы: строка в таблице есть
 * только у тех операций, которых кто-то касался. Операция без строки считается
 * запрещённой — закрыто по умолчанию.
 */
@Injectable()
export class WorkflowBackendApiAllowlistService {
  constructor(private readonly database: PgDatabase) {}

  async listOperations(): Promise<BackendApiAllowlistEntryDto[]> {
    const result = await this.database.query<AllowlistRow>(
      `SELECT operation_id, enabled, curated_by, curated_at, note FROM workflow_backend_api_allowlist`,
    );
    const byId = new Map(result.rows.map((row) => [row.operation_id, row]));

    return BACKEND_API_OPERATIONS.map((operation) => {
      const row = byId.get(operation.operation_id);
      return {
        operation_id: operation.operation_id,
        method: operation.method,
        path: operation.path,
        summary: operation.summary,
        tag: operation.tag,
        mutates: operation.method !== "GET",
        enabled: row?.enabled ?? false,
        curated_at: row ? row.curated_at.toISOString() : null,
        note: row?.note ?? null,
      };
    });
  }

  async setEnabled(
    operationId: string,
    enabled: boolean,
    actorUserId: string | undefined,
    note: string | undefined,
  ): Promise<BackendApiAllowlistEntryDto> {
    // Разрешать можно только то, что реально существует в API: иначе витрина
    // копила бы записи про исчезнувшие маршруты.
    if (!isBackendApiOperationId(operationId)) {
      throw new BadRequestException({
        code: "BACKEND_API_OPERATION_UNKNOWN",
        description: `Operation ${operationId} is not present in the generated Backend API catalog.`,
        humanMessage: `Вызова «${operationId}» нет в каталоге Backend API.`,
      });
    }

    await this.database.query(
      `
        INSERT INTO workflow_backend_api_allowlist (operation_id, enabled, curated_by, curated_at, note)
        VALUES ($1, $2, $3, now(), $4)
        ON CONFLICT (operation_id) DO UPDATE
          SET enabled = EXCLUDED.enabled,
              curated_by = EXCLUDED.curated_by,
              curated_at = now(),
              note = EXCLUDED.note
      `,
      [operationId, enabled, actorUserId ?? null, note ?? null],
    );

    const operations = await this.listOperations();
    return operations.find((item) => item.operation_id === operationId) as BackendApiAllowlistEntryDto;
  }
}
