import { MESSAGE_STATUS } from "../../../../../packages/contracts/message-model/index.mjs";
import {
  createEdgeTunnelAck,
  validateEdgeTunnelMessage,
} from "../../../../../packages/contracts/src/c9.mjs";
import { validateBroadcastCoreDeliveryDraft } from "../../../../../packages/contracts/src/c8.mjs";

import { buildC2EgressDelivery } from "./communication-core-m1.mjs";

/**
 * M4 SVC-CORE coordinators.
 *
 * Two integration seams route through the single delivery mechanism of the core:
 *  - CP-7 (SVC-EDGE -> CORE, C9): восстановление порядка по sequence_number
 *    в рамках endpoint_id и дедупликация по idempotency_key после разрыва/дренажа буфера.
 *  - CP-6 (SVC-BCAST -> CORE, C8/C1/C2): доставка кампаний строго через ядро,
 *    со связью broadcast_messages <-> messages и полным журналом попыток доставки.
 */

export class CommunicationCoreM4ValidationError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = "CommunicationCoreM4ValidationError";
    this.errors = errors;
  }
}

/**
 * CP-7 приёмник от SVC-EDGE.
 *
 * Буфер SVC-EDGE может отдать сообщения не по порядку (после переподключения)
 * и с повторами (после повторного дренажа). Координатор восстанавливает порядок
 * по (endpoint_id, sequence_number), дедуплицирует по idempotency_key и
 * передаёт каждое сообщение в ядро через единый ingress-путь, который сам
 * повторно дедуплицирует по message_id.
 */
export function createEdgeIntakeCoordinator({
  core,
  clock = () => new Date().toISOString(),
  validate = true,
} = {}) {
  if (!core || typeof core.acceptIngressMessage !== "function") {
    throw new TypeError("core with acceptIngressMessage(payload) is required");
  }

  async function intakeBatch(tunnelMessages, options = {}) {
    if (!Array.isArray(tunnelMessages)) {
      throw new TypeError("tunnelMessages must be an array");
    }

    const shouldValidate = options.validate ?? validate;
    const incoming = tunnelMessages.map((tunnelMessage, receivedIndex) => ({
      tunnelMessage,
      receivedIndex,
    }));

    if (shouldValidate) {
      for (const { tunnelMessage, receivedIndex } of incoming) {
        const validation = validateEdgeTunnelMessage(tunnelMessage);
        if (!validation.valid) {
          throw new CommunicationCoreM4ValidationError(
            `Invalid C9 edge tunnel message at index ${receivedIndex}: ${validation.errors.join("; ")}`,
            validation.errors,
          );
        }
      }
    }

    // Дедуп внутри батча по idempotency_key (оставляем первое вхождение).
    const seenInBatch = new Set();
    const unique = [];
    let batchDuplicates = 0;
    for (const item of incoming) {
      const key = item.tunnelMessage.idempotency_key;
      if (seenInBatch.has(key)) {
        batchDuplicates += 1;
        continue;
      }
      seenInBatch.add(key);
      unique.push(item);
    }

    // Восстановление порядка: сначала по endpoint_id, затем по sequence_number.
    const ordered = [...unique].sort((left, right) => {
      const leftEndpoint = left.tunnelMessage.endpoint_id;
      const rightEndpoint = right.tunnelMessage.endpoint_id;
      if (leftEndpoint !== rightEndpoint) {
        return String(leftEndpoint).localeCompare(String(rightEndpoint));
      }
      return (
        Number(left.tunnelMessage.sequence_number) -
        Number(right.tunnelMessage.sequence_number)
      );
    });

    // Порядок был восстановлен, если после сортировки исходные индексы
    // перестали идти строго по возрастанию.
    const reordered = ordered.some(
      (item, index) => index > 0 && ordered[index - 1].receivedIndex > item.receivedIndex,
    );

    const acks = [];
    let forwarded = 0;
    let duplicates = batchDuplicates;

    for (const { tunnelMessage } of ordered) {
      const acceptance = await core.acceptIngressMessage(tunnelMessage.payload);
      if (acceptance.duplicate) {
        duplicates += 1;
      } else {
        forwarded += 1;
      }

      acks.push(
        createEdgeTunnelAck({
          accepted: acceptance.accepted !== false,
          duplicate: Boolean(acceptance.duplicate),
          messageId: acceptance.message_id,
          endpointId: tunnelMessage.endpoint_id,
          sequenceNumber: tunnelMessage.sequence_number,
          idempotencyKey: tunnelMessage.idempotency_key,
          coreStatus: acceptance.status ?? MESSAGE_STATUS.RECEIVED,
          receivedAt: clock(),
        }),
      );
    }

    return {
      received: tunnelMessages.length,
      accepted: forwarded,
      forwarded,
      duplicates,
      reordered,
      acks,
    };
  }

  async function intake(tunnelMessage, options = {}) {
    const result = await intakeBatch([tunnelMessage], options);
    return result.acks[0];
  }

  return { intake, intakeBatch };
}

/**
 * CP-6 координатор доставки кампаний через ядро.
 *
 * SVC-BCAST готовит канонический C1-черновик (C8.BroadcastCoreDeliveryDraft) и
 * никогда не обращается к адаптерам напрямую. Координатор фиксирует исходящее
 * broadcast-сообщение (дедуп по message_id), связывает broadcast_messages <->
 * messages и доставляет через C2 egress с полным журналом попыток.
 */
export function createBroadcastDeliveryCoordinator({
  store,
  egressAdapter,
  clock = () => new Date().toISOString(),
  adapter = "broadcast",
  maxAttempts = 1,
} = {}) {
  if (!store || typeof store.recordBroadcastDelivery !== "function") {
    throw new TypeError("store with recordBroadcastDelivery(...) is required");
  }
  if (!egressAdapter || typeof egressAdapter.deliver !== "function") {
    throw new TypeError("egressAdapter with deliver(delivery) is required");
  }

  async function deliver(draft, options = {}) {
    const validation = validateBroadcastCoreDeliveryDraft(draft);
    if (!validation.valid) {
      throw new CommunicationCoreM4ValidationError(
        `Invalid C8 broadcast delivery draft: ${validation.errors.join("; ")}`,
        validation.errors,
      );
    }

    const organizationId = draft.organization_id;
    const broadcastId = draft.broadcast_id;

    const recorded = await store.recordBroadcastDelivery({
      organizationId,
      broadcastId,
      broadcastName: options.broadcastName,
      draft,
      occurredAt: clock(),
    });

    // Окно дедупликации: повторный черновик той же кампании/сообщения
    // не приводит к повторной доставке через адаптер.
    if (recorded.duplicate) {
      return {
        duplicate: true,
        delivered: recorded.message.status === MESSAGE_STATUS.SENT,
        broadcast_id: broadcastId,
        message_id: recorded.message.id,
        conversation_id: recorded.conversation?.id ?? recorded.message.conversation_id,
        endpoint_id: recorded.endpoint?.id ?? recorded.message.endpoint_id,
        sequence_number: recorded.message.sequence_number,
        status: recorded.message.status,
        broadcast_message_status: recorded.broadcastMessage?.status ?? null,
        error: null,
        attempts: [],
      };
    }

    const delivery = buildC2EgressDelivery({
      message: recorded.message,
      endpoint: recorded.endpoint,
    });

    const limit = Math.max(1, options.maxAttempts ?? maxAttempts);
    const attempts = [];
    let attemptNo = 1;
    let finalStatus;
    let finalError = null;

    while (attemptNo <= limit) {
      let deliveryResult;
      try {
        deliveryResult = await egressAdapter.deliver(delivery);
      } catch (error) {
        deliveryResult = { accepted: false, error: error.message };
      }

      const success = deliveryResult.accepted !== false;
      const isFinal = success || attemptNo === limit;

      if (isFinal) {
        const transitioned = await store.recordDeliveryAttemptAndTransition({
          organizationId,
          messageId: recorded.message.id,
          adapter,
          attemptNo,
          status: success ? MESSAGE_STATUS.SENT : MESSAGE_STATUS.FAILED,
          error: deliveryResult.error ?? null,
          occurredAt: clock(),
        });
        attempts.push(transitioned.deliveryAttempt);
        finalStatus = transitioned.message.status;
        finalError = deliveryResult.error ?? null;
        break;
      }

      // Промежуточная неудачная попытка фиксируется в журнале без перехода
      // статуса сообщения (failed — терминальный статус), сообщение остаётся
      // routed до финального исхода.
      const intermediate = await store.recordDeliveryAttempt({
        organizationId,
        messageId: recorded.message.id,
        adapter,
        attemptNo,
        status: MESSAGE_STATUS.FAILED,
        error: deliveryResult.error ?? null,
        occurredAt: clock(),
      });
      attempts.push(intermediate.deliveryAttempt);
      attemptNo += 1;
    }

    const broadcastMessageStatus =
      finalStatus === MESSAGE_STATUS.SENT ? "sent" : "failed";
    const link = await store.updateBroadcastMessageStatus({
      organizationId,
      broadcastId,
      messageId: recorded.message.id,
      status: broadcastMessageStatus,
      occurredAt: clock(),
    });

    return {
      duplicate: false,
      delivered: finalStatus === MESSAGE_STATUS.SENT,
      broadcast_id: broadcastId,
      message_id: recorded.message.id,
      conversation_id: recorded.conversation.id,
      endpoint_id: recorded.endpoint.id,
      sequence_number: recorded.message.sequence_number,
      status: finalStatus,
      broadcast_message_status: link.status,
      error: finalError,
      attempts,
    };
  }

  async function deliverBatch(drafts, options = {}) {
    if (!Array.isArray(drafts)) {
      throw new TypeError("drafts must be an array");
    }

    const results = [];
    for (const draft of drafts) {
      results.push(await deliver(draft, options));
    }

    const delivered = results.filter((result) => result.delivered).length;
    const duplicates = results.filter((result) => result.duplicate).length;
    const failed = results.filter(
      (result) => !result.duplicate && !result.delivered,
    ).length;

    return {
      total: drafts.length,
      delivered,
      duplicates,
      failed,
      results,
    };
  }

  return { deliver, deliverBatch };
}
