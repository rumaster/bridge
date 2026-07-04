import { MESSAGE_STATUS } from "../../../../../packages/contracts/message-model/index.mjs";
import {
  createEdgeTunnelAck,
  validateEdgeTunnelMessage,
} from "../../../../../packages/contracts/src/c9.mjs";
import { validateBroadcastCoreDeliveryDraft } from "../../../../../packages/contracts/src/c8.mjs";
import { buildC2EgressDelivery as buildLegacyC2EgressDelivery } from "./communication-core-m1.mjs";

export {
  CommunicationCoreMockValidationError,
  createCommunicationCoreMock,
} from "./mock-ingress-egress.mjs";
export {
  CommunicationCoreM1NotFoundError,
  CommunicationCoreM1ValidationError,
  InMemoryCommunicationCoreStore,
  assertStatusTransition,
  buildC2EgressDelivery,
  createCommunicationCoreM1Service,
  createFbpWorkflowOutboxPublisher,
  createHttpC2EgressAdapter,
  createInMemoryC7EventPublisher,
  createMockC2EgressAdapter,
  createPostgresCommunicationCoreStore,
  uuidFromText,
} from "./communication-core-m1.mjs";
export { createCommunicationCoreModule } from "./communication-core-module.mjs";

const DEFAULT_TIMEOUT_MS = 250;
const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_CONCURRENCY = 8;

export class CommunicationCoreM4ValidationError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = "CommunicationCoreM4ValidationError";
    this.errors = errors;
  }
}

export class CommunicationCoreM5ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CommunicationCoreM5ValidationError";
  }
}

export class CommunicationCoreM5TimeoutError extends Error {
  constructor(message = "Communication Core M5 dependency call timed out.") {
    super(message);
    this.name = "CommunicationCoreM5TimeoutError";
  }
}

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

    const incoming = tunnelMessages.map((tunnelMessage, receivedIndex) => ({
      tunnelMessage,
      receivedIndex,
    }));
    if (options.validate ?? validate) {
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

    const delivery = buildLegacyC2EgressDelivery({
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

    return {
      total: drafts.length,
      delivered: results.filter((result) => result.delivered).length,
      duplicates: results.filter((result) => result.duplicate).length,
      failed: results.filter((result) => !result.duplicate && !result.delivered).length,
      results,
    };
  }

  return { deliver, deliverBatch };
}

export function createAdapterFailureCoordinator({
  store,
  adapterClient,
  adapter = "adapter",
  clock = () => new Date().toISOString(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
} = {}) {
  if (
    !store ||
    typeof store.recordDeliveryAttempt !== "function" ||
    typeof store.recordDeliveryAttemptAndTransition !== "function"
  ) {
    throw new TypeError(
      "store with recordDeliveryAttempt(...) and recordDeliveryAttemptAndTransition(...) is required",
    );
  }

  async function deliver({
    organizationId,
    messageId,
    delivery,
    adapter: deliveryAdapter = adapter,
    timeoutMs: deliveryTimeoutMs = timeoutMs,
    maxAttempts: deliveryMaxAttempts = maxAttempts,
  } = {}) {
    assertNonBlank(organizationId, "organizationId");
    assertNonBlank(messageId, "messageId");

    const attemptLimit = Math.max(1, Number(deliveryMaxAttempts) || DEFAULT_MAX_ATTEMPTS);
    const attempts = [];
    let finalStatus = MESSAGE_STATUS.FAILED;
    let finalReason = "adapter_unavailable";
    let finalError = "adapter unavailable";

    for (let attemptNo = 1; attemptNo <= attemptLimit; attemptNo += 1) {
      const outcome = await attemptDelivery({
        adapterClient,
        delivery,
        timeoutMs: deliveryTimeoutMs,
      });
      const success = outcome.accepted === true;
      const isFinal = success || attemptNo === attemptLimit;
      finalReason = outcome.reason;
      finalError = outcome.error ?? null;

      if (isFinal) {
        const transitioned = await store.recordDeliveryAttemptAndTransition({
          organizationId,
          messageId,
          adapter: deliveryAdapter,
          attemptNo,
          status: success ? MESSAGE_STATUS.SENT : MESSAGE_STATUS.FAILED,
          error: outcome.error ?? null,
          occurredAt: clock(),
        });
        attempts.push(transitioned.deliveryAttempt);
        finalStatus = transitioned.message.status;

        return {
          accepted: success,
          delivered: success,
          degraded: !success,
          reason: success ? null : finalReason,
          error: success ? null : finalError,
          message_id: messageId,
          organization_id: organizationId,
          status: finalStatus,
          attempts,
          attempt_count: attempts.length,
        };
      }

      const intermediate = await store.recordDeliveryAttempt({
        organizationId,
        messageId,
        adapter: deliveryAdapter,
        attemptNo,
        status: MESSAGE_STATUS.FAILED,
        error: outcome.error ?? null,
        occurredAt: clock(),
      });
      attempts.push(intermediate.deliveryAttempt);
    }

    return {
      accepted: false,
      delivered: false,
      degraded: true,
      reason: finalReason,
      error: finalError,
      message_id: messageId,
      organization_id: organizationId,
      status: finalStatus,
      attempts,
      attempt_count: attempts.length,
    };
  }

  return { deliver };
}

export function createAiDegradationGuard({
  aiClient,
  clock = () => new Date().toISOString(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fallback = defaultAiFallback,
} = {}) {
  async function suggest(request = {}, options = {}) {
    const effectiveTimeoutMs = options.timeoutMs ?? timeoutMs;
    const startedAt = clock();

    if (!aiClient || typeof aiClient.suggest !== "function") {
      return degradedAiResponse({
        request,
        reason: "no_client",
        error: "AI client is not configured.",
        fallback,
        startedAt,
        finishedAt: clock(),
      });
    }

    try {
      const response = await withTimeout(
        Promise.resolve().then(() => aiClient.suggest(request)),
        effectiveTimeoutMs,
      );

      return {
        degraded: false,
        reason: null,
        response,
        started_at: startedAt,
        finished_at: clock(),
      };
    } catch (error) {
      return degradedAiResponse({
        request,
        reason: reasonForError(error),
        error: error.message,
        fallback,
        startedAt,
        finishedAt: clock(),
      });
    }
  }

  return { suggest };
}

export function createCommunicationCoreLoadProbe({
  core,
  clock = () => new Date().toISOString(),
  now = defaultHighResolutionNow,
} = {}) {
  if (!core || typeof core.acceptIngressMessage !== "function") {
    throw new TypeError("core with acceptIngressMessage(payload) is required");
  }

  async function runIngressProbe({
    name = "communication-core-ingress-routing",
    messages,
    concurrency = DEFAULT_CONCURRENCY,
  } = {}) {
    return runLoadProbe({
      name,
      items: messages,
      concurrency,
      clock,
      now,
      task: (message) => core.acceptIngressMessage(message),
      accepted: (result) => result?.accepted !== false,
      duplicate: (result) => result?.duplicate === true,
    });
  }

  return { runIngressProbe };
}

export async function runLoadProbe({
  name,
  items,
  task,
  concurrency = DEFAULT_CONCURRENCY,
  clock = () => new Date().toISOString(),
  now = defaultHighResolutionNow,
  accepted = () => true,
  duplicate = () => false,
} = {}) {
  if (!Array.isArray(items)) {
    throw new CommunicationCoreM5ValidationError("items must be an array");
  }
  if (typeof task !== "function") {
    throw new CommunicationCoreM5ValidationError("task must be a function");
  }

  const startedAt = clock();
  const started = now();
  const latencies = [];
  const errors = [];
  const sampleResults = [];
  let acceptedCount = 0;
  let duplicateCount = 0;
  let failedCount = 0;
  let nextIndex = 0;
  let inFlight = 0;
  let peakInFlight = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      const itemStarted = now();

      try {
        const result = await task(items[index], index);
        if (accepted(result)) {
          acceptedCount += 1;
        } else {
          failedCount += 1;
        }
        if (duplicate(result)) {
          duplicateCount += 1;
        }
        if (sampleResults.length < 5) {
          sampleResults.push(result);
        }
      } catch (error) {
        failedCount += 1;
        errors.push({
          index,
          name: error.name,
          message: error.message,
        });
      } finally {
        latencies.push(Math.max(0, now() - itemStarted));
        inFlight -= 1;
      }
    }
  }

  const workerCount = Math.min(
    Math.max(1, Number(concurrency) || DEFAULT_CONCURRENCY),
    Math.max(1, items.length),
  );
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const durationMs = Math.max(0.001, now() - started);

  return {
    name,
    started_at: startedAt,
    finished_at: clock(),
    total: items.length,
    accepted: acceptedCount,
    duplicates: duplicateCount,
    failed: failedCount,
    peak_in_flight: peakInFlight,
    concurrency: workerCount,
    duration_ms: round(durationMs),
    throughput_per_second: round((items.length / durationMs) * 1000),
    latency_ms: latencySummary(latencies),
    errors,
    sample_results: sampleResults,
  };
}

async function attemptDelivery({ adapterClient, delivery, timeoutMs }) {
  if (!adapterClient || typeof adapterClient.deliver !== "function") {
    return {
      accepted: false,
      reason: "no_client",
      error: "adapter unavailable",
    };
  }

  try {
    const result = await withTimeout(
      Promise.resolve().then(() => adapterClient.deliver(delivery)),
      timeoutMs,
    );
    if (result?.accepted !== true) {
      return {
        accepted: false,
        reason: "adapter_rejected",
        error: result?.error ?? "adapter did not accept delivery",
      };
    }

    return {
      accepted: true,
      reason: null,
      error: null,
    };
  } catch (error) {
    return {
      accepted: false,
      reason: reasonForError(error),
      error: error.message,
    };
  }
}

function defaultAiFallback() {
  return {
    contract: "C4.AiAssistantSuggestResponse",
    degraded: true,
    suggestions: [],
  };
}

function degradedAiResponse({
  request,
  reason,
  error,
  fallback,
  startedAt,
  finishedAt,
}) {
  return {
    degraded: true,
    reason,
    error,
    response: fallback(request, reason),
    started_at: startedAt,
    finished_at: finishedAt,
  };
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new CommunicationCoreM5TimeoutError());
    }, Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function latencySummary(values) {
  if (values.length === 0) {
    return {
      min: 0,
      avg: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0,
    };
  }

  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((acc, value) => acc + value, 0);

  return {
    min: round(sorted[0]),
    avg: round(sum / sorted.length),
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
    max: round(sorted.at(-1)),
  };
}

function percentile(sorted, rank) {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * rank) - 1),
  );
  return sorted[index];
}

function reasonForError(error) {
  if (error instanceof CommunicationCoreM5TimeoutError) {
    return "timeout";
  }

  return "error";
}

function assertNonBlank(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CommunicationCoreM5ValidationError(`${field} must be a non-empty string`);
  }
}

function defaultHighResolutionNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function round(value) {
  return Math.round(Number(value) * 1000) / 1000;
}
