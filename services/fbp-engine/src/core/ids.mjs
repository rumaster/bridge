import { createHash } from "node:crypto";

/**
 * Детерминированный UUIDv4-совместимый идентификатор из стабильных частей.
 * Детерминизм важен для воспроизводимости исполнения и тестов: одинаковый вход
 * (organization_id, instance_id, порядковый номер и т.п.) даёт один и тот же id,
 * без обращения к ГСЧ или системному времени.
 */
export function deterministicUuid(parts) {
  const hash = createHash("sha256").update(parts.map(String).join("")).digest("hex");
  const variant = (8 + (Number.parseInt(hash[16], 16) % 4)).toString(16);

  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `${variant}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}
