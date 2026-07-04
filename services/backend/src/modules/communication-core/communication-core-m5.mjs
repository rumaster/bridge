import { MESSAGE_STATUS } from "../../../../../packages/contracts/message-model/index.mjs";

const DEFAULT_TIMEOUT_MS = 250;
const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_CONCURRENCY = 8;

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

/**
 * M5 adapter degradation coordinator.
 *
 * It keeps failures outside the core hot path: adapter calls are bounded by a
 * timeout and a finite retry budget; failed intermediate attempts are logged
 * without moving the message to a terminal status; only the final failed attempt
 * transitions the routed message to `failed`.
 */
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

/**
 * AI is an optional side dependency for the core. A timeout/error here returns a
 * structured degraded response instead of propagating an exception into message
 * acceptance/routing.
 */
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
