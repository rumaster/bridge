import { validateEdgeTunnelMessage } from "../../../packages/contracts/src/c9.js";

/**
 * SVC-EDGE буферизующий шлюз (CP-7, §7.9-§7.10).
 *
 * Транспортный слой SVC-EDGE. Во время разрыва соединения с ядром сообщения
 * туннеля C9 накапливаются в локальном буфере (дедуп по idempotency_key,
 * порядок поступления сохраняется). После восстановления соединения буфер
 * дренажируется в ядро одним батчем через переданный `forward` — именно
 * SVC-CORE восстанавливает порядок по sequence_number и повторно
 * дедуплицирует. Сам шлюз порядок не восстанавливает: это ответственность ядра.
 */
export class BufferedEdgeGatewayValidationError extends Error {
  readonly errors: string[];

  constructor(message: string, errors: string[] = []) {
    super(message);
    this.name = "BufferedEdgeGatewayValidationError";
    this.errors = errors;
  }
}

export interface CreateBufferedEdgeGatewayOptions {
  forward?: (tunnelMessages: any) => any;
  now?: () => string;
  connected?: boolean;
}

export function createBufferedEdgeGateway({
  forward,
  now = () => new Date().toISOString(),
  connected = true,
}: CreateBufferedEdgeGatewayOptions = {}) {
  if (typeof forward !== "function") {
    throw new TypeError("forward(tunnelMessages) callback is required");
  }

  const buffer = new Map();
  let online = Boolean(connected);
  const metrics = {
    buffered_total: 0,
    forwarded_online_total: 0,
    drained_total: 0,
    rejected_total: 0,
  };

  function assertValid(tunnelMessage) {
    const validation = validateEdgeTunnelMessage(tunnelMessage);
    if (!validation.valid) {
      metrics.rejected_total += 1;
      throw new BufferedEdgeGatewayValidationError(
        `Invalid C9 tunnel message: ${validation.errors.join("; ")}`,
        validation.errors,
      );
    }
  }

  return {
    isConnected() {
      return online;
    },

    disconnect() {
      online = false;
    },

    async connect() {
      online = true;
      return this.drain();
    },

    bufferedCount() {
      return buffer.size;
    },

    async receive(tunnelMessage) {
      assertValid(tunnelMessage);

      if (!online) {
        // Дедуп при буферизации: повторное поступление того же idempotency_key
        // не создаёт второй записи в буфере.
        if (!buffer.has(tunnelMessage.idempotency_key)) {
          buffer.set(tunnelMessage.idempotency_key, {
            ...tunnelMessage,
            timestamps: {
              ...tunnelMessage.timestamps,
              buffered_at: now(),
            },
          });
          metrics.buffered_total += 1;
        }

        return { buffered: true, forwarded: false, bufferedCount: buffer.size };
      }

      const result = await forward([tunnelMessage]);
      metrics.forwarded_online_total += 1;

      return { buffered: false, forwarded: true, result };
    },

    async drain() {
      const pending = Array.from(buffer.values());
      if (pending.length === 0) {
        return { drained: 0, result: null };
      }

      const result = await forward(pending);
      buffer.clear();
      metrics.drained_total += pending.length;

      return { drained: pending.length, result };
    },

    getMetrics() {
      return { ...metrics };
    },
  };
}
