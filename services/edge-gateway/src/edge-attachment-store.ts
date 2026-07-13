import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Хранилище байтов вложений на Edge Gateway (Этап «вложения» плана
 * `docs/plan/email-channel-production.md` §4.3, закрывает остаточный разрыв 4:
 * `storage_ref` был непрозрачной заглушкой `email-attachment://…`, байты письма
 * не сохранялись — менеджер не мог скачать вложение).
 *
 * По решению 1 (email — Edge-owned, РФ-резидентность ПДн, 152-ФЗ) байты вложений
 * ФИЗИЧЕСКИ остаются на RF-стороне (Edge), а не едут через туннель за рубеж
 * заранее: менеджер (App-сторона) скачивает их лениво по запросу через
 * backend-прокси (`GET /v1/attachments/:id/content` → Edge
 * `GET /internal/edge/attachments?ref=…`). Так «не тащим байты за рубеж без
 * нужды».
 *
 * MVP-реализация — файловый том на RF ({@link createFilesystemAttachmentStore}),
 * за интерфейсом {@link EdgeAttachmentStore}: object storage (self-hosted
 * S3-совместимый MinIO для полной резидентности) подключается позже той же
 * поверхностью, без изменений вызывающего кода. S3 сознательно отложен на MVP
 * (см. `mock-to-production.md` §4.15).
 *
 * `storage_ref` — непрозрачная для ядра строка вида
 * `edge-attach://<organization_id>/<sha256>`. Content-hash (sha256) в пути даёт
 * дедупликацию: одинаковые байты (одно письмо переслано, дубль вложения) кладутся
 * один раз. Ядро НЕ парсит схему — хранит и отдаёт ref как есть; резолвит только
 * Edge (сторона, где реально лежат байты).
 */

export const ATTACHMENT_REF_SCHEME = "edge-attach";

export interface AttachmentPutInput {
  /** Байты вложения (mailparser отдаёт Buffer целиком). */
  content: Buffer | Uint8Array;
  organizationId: string;
  /** MIME для отдачи при резолве (Content-Type). */
  mime?: string;
  /** Исходное имя файла (сохраняется в sidecar-метаданных для Content-Disposition). */
  filename?: string;
}

export interface AttachmentPutResult {
  /** Непрозрачный для ядра ref: `edge-attach://<org>/<sha256>`. */
  storageRef: string;
  /** sha256 контента (hex) — ключ дедупликации. */
  contentHash: string;
  /** Фактический размер сохранённых байтов. */
  size: number;
  /** true — байты уже лежали (дедуп), запись пропущена. */
  deduped: boolean;
}

export interface AttachmentGetResult {
  content: Buffer;
  mime?: string;
  filename?: string;
  size: number;
}

export interface AttachmentSweepOptions {
  /**
   * TTL в миллисекундах: объект удаляется, когда его возраст (now − mtime)
   * ≥ ttlMs. Возраст меряется по mtime файла байтов (время последней записи —
   * для дедуп-объекта это первая запись; повторные ссылки mtime не двигают).
   */
  ttlMs: number;
  /** Текущее время (мс от эпохи) для сравнения; по умолчанию `Date.now()`. */
  now?: number;
  /**
   * Защита дедуп-объектов: если задана и вернёт `true`, объект НЕ удаляется,
   * даже если просрочен по TTL. Точка расширения под будущий GC-по-ссылкам:
   * App-сторона (таблица `attachments`) через control-plane отдаёт множество
   * «живых» `storage_ref`, и сборщик не трогает объект, на который ссылается
   * хотя бы одно сообщение. Ошибка предиката трактуется как «жив» (не удаляем —
   * лучше протечь байтами, чем удалить нужное).
   */
  isLive?: (storageRef: string, parsed: ParsedAttachmentRef) => boolean | Promise<boolean>;
}

export interface AttachmentSweepResult {
  /** Просканировано объектов (файлов байтов, без sidecar). */
  scanned: number;
  /** Удалено объектов (байты + sidecar). */
  deleted: number;
  /** Сохранено объектов, защищённых `isLive` несмотря на просрочку. */
  kept: number;
  /** Освобождено байт (сумма размеров удалённых файлов). */
  reclaimedBytes: number;
  /** Число объектов, которые не удалось удалить (ошибка ФС) — свип не падает. */
  errors: number;
}

export interface EdgeAttachmentStore {
  /**
   * Сохраняет байты и возвращает непрозрачный `storage_ref`. Бросает
   * {@link AttachmentTooLargeError}, если размер превышает лимит.
   */
  put(input: AttachmentPutInput): Promise<AttachmentPutResult>;
  /** Читает байты по `storage_ref`; null — если объект не найден. */
  get(storageRef: string): Promise<AttachmentGetResult | null>;
  /** Разрешён ли этот ref данному хранилищем (схема + разбор). */
  canResolve(storageRef: string): boolean;
  /**
   * Удаляет просроченные по TTL объекты (retention/GC на RF-томе, см.
   * `docs/plan/email-channel-production.md` §Follow-up п.1). Идемпотентен и
   * безопасен к параллельным `put`: объект уже записан целиком до появления в
   * листинге, а дедуп детерминирован по content-hash — удалённый объект будет
   * пересоздан при следующем письме с теми же байтами.
   */
  sweep(options: AttachmentSweepOptions): Promise<AttachmentSweepResult>;
}

/** Размер вложения превысил лимит хранилища — байты не сохранены. */
export class AttachmentTooLargeError extends Error {
  readonly tooLarge = true;
  constructor(
    readonly size: number,
    readonly maxBytes: number,
  ) {
    super(`attachment size ${size} exceeds limit ${maxBytes}`);
    this.name = "AttachmentTooLargeError";
  }
}

export interface FilesystemAttachmentStoreOptions {
  /** Корневой каталог тома (RF). Внутри — `<organization_id>/<sha256>`. */
  baseDir: string;
  /** Максимальный размер одного вложения (байты). Больше — {@link AttachmentTooLargeError}. */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Файловое хранилище вложений (MVP). Кладёт `<baseDir>/<org>/<sha256>` + sidecar
 * `<...>.meta.json` (mime/filename для резолва). Дедуп по существованию файла с
 * тем же sha256.
 */
export function createFilesystemAttachmentStore({
  baseDir,
  maxBytes = DEFAULT_MAX_BYTES,
}: FilesystemAttachmentStoreOptions): EdgeAttachmentStore {
  if (typeof baseDir !== "string" || baseDir.trim() === "") {
    throw new TypeError("baseDir is required for filesystem attachment store");
  }

  function pathsFor(organizationId: string, contentHash: string): { file: string; meta: string } {
    // Сегменты санитизируем: sha256 — hex, org — UUID; лишнее режем, чтобы ref из
    // конверта не мог вырваться из baseDir (защита от path traversal).
    const org = safeSegment(organizationId);
    const hash = safeSegment(contentHash);
    const file = join(baseDir, org, hash);
    return { file, meta: `${file}.meta.json` };
  }

  return {
    async put({ content, organizationId, mime, filename }: AttachmentPutInput): Promise<AttachmentPutResult> {
      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
      const size = buffer.byteLength;
      if (size > maxBytes) {
        throw new AttachmentTooLargeError(size, maxBytes);
      }
      const contentHash = createHash("sha256").update(buffer).digest("hex");
      const storageRef = `${ATTACHMENT_REF_SCHEME}://${organizationId}/${contentHash}`;
      const { file, meta } = pathsFor(organizationId, contentHash);

      if (await fileExists(file)) {
        return { storageRef, contentHash, size, deduped: true };
      }

      await mkdir(dirname(file), { recursive: true });
      // Метаданные пишем ДО байтов: если процесс упадёт между записями, «сирота»
      // — это meta без файла (get вернёт null), а не байты без mime.
      await writeFile(meta, JSON.stringify({ mime: mime ?? null, filename: filename ?? null, size }));
      await writeFile(file, buffer);
      return { storageRef, contentHash, size, deduped: false };
    },

    async get(storageRef: string): Promise<AttachmentGetResult | null> {
      const parsed = parseAttachmentRef(storageRef);
      if (!parsed) {
        return null;
      }
      const { file, meta } = pathsFor(parsed.organizationId, parsed.contentHash);
      let content: Buffer;
      try {
        content = await readFile(file);
      } catch {
        return null;
      }
      let mime: string | undefined;
      let filename: string | undefined;
      try {
        const raw = JSON.parse(await readFile(meta, "utf8")) as {
          mime?: string | null;
          filename?: string | null;
        };
        mime = raw.mime ?? undefined;
        filename = raw.filename ?? undefined;
      } catch {
        // sidecar утрачен — отдаём байты без mime/filename (не критично).
      }
      return { content, mime, filename, size: content.byteLength };
    },

    canResolve(storageRef: string): boolean {
      return parseAttachmentRef(storageRef) !== null;
    },

    async sweep({ ttlMs, now = Date.now(), isLive }: AttachmentSweepOptions): Promise<AttachmentSweepResult> {
      const result: AttachmentSweepResult = { scanned: 0, deleted: 0, kept: 0, reclaimedBytes: 0, errors: 0 };
      if (!Number.isFinite(ttlMs) || ttlMs < 0) {
        return result;
      }

      let orgEntries: Dirent[];
      try {
        orgEntries = await readdir(baseDir, { withFileTypes: true });
      } catch {
        // Том ещё не создан (ни одного вложения) — удалять нечего.
        return result;
      }

      for (const orgEntry of orgEntries) {
        if (!orgEntry.isDirectory()) {
          continue;
        }
        const org = orgEntry.name;
        const orgDir = join(baseDir, org);
        let files: string[];
        try {
          files = await readdir(orgDir);
        } catch {
          continue;
        }

        for (const name of files) {
          // Каталог хранит объект `<sha256>` + sidecar `<sha256>.meta.json`.
          // Итерируем только по объектам байтов; sidecar удаляем вместе с ними.
          if (!/^[0-9a-f]{64}$/i.test(name)) {
            continue;
          }
          result.scanned += 1;
          const file = join(orgDir, name);
          let info: Stats;
          try {
            info = await stat(file);
          } catch {
            // Файл исчез между листингом и stat (конкурентный свип/put) — пропускаем.
            continue;
          }
          if (now - info.mtimeMs < ttlMs) {
            continue;
          }

          if (isLive) {
            const storageRef = `${ATTACHMENT_REF_SCHEME}://${org}/${name}`;
            let live: boolean;
            try {
              live = await isLive(storageRef, { organizationId: org, contentHash: name });
            } catch {
              // Не знаем — считаем живым и не удаляем.
              live = true;
            }
            if (live) {
              result.kept += 1;
              continue;
            }
          }

          try {
            await rm(file, { force: true });
            await rm(`${file}.meta.json`, { force: true });
            result.deleted += 1;
            result.reclaimedBytes += info.size;
          } catch {
            result.errors += 1;
          }
        }
      }

      return result;
    },
  };
}

export interface ParsedAttachmentRef {
  organizationId: string;
  contentHash: string;
}

/** Разбирает `edge-attach://<org>/<sha256>`; null — чужая схема/битый ref. */
export function parseAttachmentRef(storageRef: unknown): ParsedAttachmentRef | null {
  if (typeof storageRef !== "string") {
    return null;
  }
  const prefix = `${ATTACHMENT_REF_SCHEME}://`;
  if (!storageRef.startsWith(prefix)) {
    return null;
  }
  const rest = storageRef.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  const organizationId = rest.slice(0, slash);
  const contentHash = rest.slice(slash + 1);
  if (organizationId === "" || !/^[0-9a-f]{64}$/i.test(contentHash)) {
    return null;
  }
  return { organizationId, contentHash };
}

function safeSegment(value: string): string {
  return String(value).replace(/[^0-9a-zA-Z._-]/g, "");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
