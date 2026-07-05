import { validateBroadcastCoreDeliveryDraft } from "../../../../packages/contracts/src/c8.js";

/**
 * In-memory мок единого механизма ядра (C1/C2) для локального dev-сервера
 * SVC-BCAST.
 *
 * Повторяет наблюдаемое поведение координатора доставки ядра
 * (`createBroadcastDeliveryCoordinator`), не таща в SVC-BCAST рантайм ядра:
 *   - валидирует канонический C8-черновик (C1);
 *   - дедуплицирует по `message_id` (сквозная идемпотентность, ТЗ §11.12);
 *   - «доставляет» через инъектируемый egress (по умолчанию — успех);
 *   - хранит связь `broadcast_messages <-> messages`.
 *
 * В интеграционных/e2e-тестах вместо мока подставляется РЕАЛЬНЫЙ координатор
 * ядра — доставка идёт строго через SVC-CORE (CP-6).
 */
export function createInMemoryCoreDelivery({
  egress = async () => ({ accepted: true, status: "sent" }),
} = {}) {
  const messagesById = new Map();
  const broadcastMessages = [];

  return {
    async deliver(draft) {
      const validation = validateBroadcastCoreDeliveryDraft(draft);
      if (!validation.valid) {
        const error = new Error(
          `Invalid C8 broadcast delivery draft: ${validation.errors.join("; ")}`,
        );
        error.name = "CommunicationCoreM4ValidationError";
        error.retryable = false;
        throw error;
      }

      const messageId = draft.message.id;
      const existing = messagesById.get(messageId);
      if (existing) {
        return {
          duplicate: true,
          delivered: existing.status === "sent" || existing.status === "delivered",
          status: existing.status,
          broadcast_id: draft.broadcast_id,
          message_id: messageId,
          broadcast_message_status: existing.broadcast_message_status,
        };
      }

      let outcome;
      try {
        outcome = await egress(draft);
      } catch (error) {
        outcome = { accepted: false, error: error.message };
      }

      const accepted = outcome.accepted !== false;
      const status = accepted ? outcome.status ?? "sent" : "failed";
      const broadcastMessageStatus = accepted ? "sent" : "failed";
      const record = {
        message_id: messageId,
        status,
        broadcast_message_status: broadcastMessageStatus,
      };
      messagesById.set(messageId, record);
      broadcastMessages.push({
        broadcast_id: draft.broadcast_id,
        message_id: messageId,
        status: broadcastMessageStatus,
      });

      return {
        duplicate: false,
        delivered: accepted,
        status,
        broadcast_id: draft.broadcast_id,
        message_id: messageId,
        broadcast_message_status: broadcastMessageStatus,
        error: outcome.error ?? null,
      };
    },

    getBroadcastMessages() {
      return broadcastMessages.slice();
    },

    getMessages() {
      return Array.from(messagesById.values());
    },
  };
}
