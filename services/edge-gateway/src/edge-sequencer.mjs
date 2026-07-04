/**
 * Присвоение `sequence_number` на входе Edge (ТЗ §7.10, CP-7).
 *
 * Edge — точка первичного приёма трафика РФ, и именно он назначает монотонный
 * `sequence_number` в момент входа сообщения. Ключ партиционирования —
 * `endpoint_id`: нумерация независима для каждого endpoint, монотонна и
 * непрерывна в рамках одного endpoint. Значение затем передаётся через C9-туннель,
 * и ядро (SVC-CORE) по нему восстанавливает порядок.
 *
 * Инвариант: `sequence_number` строго возрастает в рамках `endpoint_id`, начиная
 * с 1. `restore(endpointId, lastSequence)` рехидратирует счётчик после рестарта
 * Edge по максимальному `sequence_number` из RF-буфера, чтобы нумерация не
 * начиналась заново и не конфликтовала с уже зафиксированными записями.
 */
export class EdgeSequencerError extends Error {
  constructor(message) {
    super(message);
    this.name = "EdgeSequencerError";
  }
}

export function createEdgeSequencer({ initial = {} } = {}) {
  const counters = new Map();

  for (const [endpointId, lastSequence] of Object.entries(initial)) {
    counters.set(endpointId, toPositiveInt(lastSequence, endpointId));
  }

  function assertEndpoint(endpointId) {
    if (typeof endpointId !== "string" || endpointId.trim() === "") {
      throw new EdgeSequencerError("endpoint_id (ключ партиционирования) обязателен");
    }
  }

  return {
    /**
     * Назначает следующий `sequence_number` для endpoint на входе Edge.
     * @param {string} endpointId
     * @returns {number}
     */
    assign(endpointId) {
      assertEndpoint(endpointId);
      const next = (counters.get(endpointId) ?? 0) + 1;
      counters.set(endpointId, next);
      return next;
    },

    /**
     * Текущий (последний выданный) `sequence_number` без инкремента, 0 — если не было.
     * @param {string} endpointId
     * @returns {number}
     */
    peek(endpointId) {
      assertEndpoint(endpointId);
      return counters.get(endpointId) ?? 0;
    },

    /**
     * Рехидратирует счётчик по максимальному уже зафиксированному значению.
     * Не понижает уже достигнутое значение (защита от отката нумерации).
     * @param {string} endpointId
     * @param {number} lastSequence
     */
    restore(endpointId, lastSequence) {
      assertEndpoint(endpointId);
      const value = toPositiveInt(lastSequence, endpointId);
      const current = counters.get(endpointId) ?? 0;
      counters.set(endpointId, Math.max(current, value));
    },

    /** Снимок счётчиков (endpoint_id → последний sequence_number). */
    snapshot() {
      return Object.fromEntries(counters.entries());
    },
  };
}

function toPositiveInt(value, endpointId) {
  if (!Number.isInteger(value) || value < 0) {
    throw new EdgeSequencerError(
      `sequence_number для ${endpointId} должен быть неотрицательным целым, получено ${value}`,
    );
  }
  return value;
}
