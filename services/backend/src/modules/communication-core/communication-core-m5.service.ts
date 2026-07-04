import { Injectable } from "@nestjs/common";

import { MESSAGE_STATUS } from "./message-status";
import type { MessageStatus } from "./message-status";

const DEFAULT_TIMEOUT_MS = 250;
const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_CONCURRENCY = 8;

export class CommunicationCoreM5TimeoutError extends Error {
  constructor(message = "Communication Core M5 dependency call timed out.") {
    super(message);
    this.name = "CommunicationCoreM5TimeoutError";
  }
}

export type AdapterFailureReason = "adapter_rejected" | "error" | "timeout";

export interface AdapterDeliveryOutcome {
  accepted: boolean;
  forwarded?: boolean;
  error?: string | null;
}

export interface AdapterAttemptRecord {
  attempt_no: number;
  status: MessageStatus;
  error: string | null;
}

export interface AdapterFailureDeliveryResult {
  accepted: boolean;
  delivered: boolean;
  degraded: boolean;
  reason: AdapterFailureReason | null;
  error: string | null;
  status: MessageStatus;
  forwarded: boolean;
  attempts: AdapterAttemptRecord[];
  attempt_count: number;
}

@Injectable()
export class AdapterFailureCoordinator {
  async deliver({
    callAdapter,
    recordAttempt,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
  }: {
    callAdapter: () => Promise<AdapterDeliveryOutcome>;
    recordAttempt: (attempt: {
      attemptNo: number;
      final: boolean;
      status: MessageStatus;
      error: string | null;
    }) => Promise<AdapterAttemptRecord & { messageStatus: MessageStatus }>;
    timeoutMs?: number | null;
    maxAttempts?: number | null;
  }): Promise<AdapterFailureDeliveryResult> {
    const attemptLimit = Math.max(1, Number(maxAttempts) || DEFAULT_MAX_ATTEMPTS);
    const attempts: AdapterAttemptRecord[] = [];
    let finalReason: AdapterFailureReason | null = "adapter_rejected";
    let finalError: string | null = "adapter did not accept delivery";
    let finalStatus: MessageStatus = MESSAGE_STATUS.FAILED;
    let forwarded = false;

    for (let attemptNo = 1; attemptNo <= attemptLimit; attemptNo += 1) {
      const outcome = await this.attemptDelivery(callAdapter, timeoutMs);
      const success = outcome.accepted === true;
      const final = success || attemptNo === attemptLimit;
      finalReason = success ? null : outcome.reason;
      finalError = success ? null : (outcome.error ?? "adapter did not accept delivery");
      forwarded = forwarded || outcome.forwarded === true;

      const attemptStatus = success ? MESSAGE_STATUS.SENT : MESSAGE_STATUS.FAILED;
      const recorded = await recordAttempt({
        attemptNo,
        final,
        status: attemptStatus,
        error: finalError,
      });
      attempts.push({
        attempt_no: recorded.attempt_no,
        status: recorded.status,
        error: recorded.error,
      });

      if (final) {
        finalStatus = recorded.messageStatus;

        return {
          accepted: success,
          delivered: success,
          degraded: !success,
          reason: finalReason,
          error: finalError,
          status: finalStatus,
          forwarded,
          attempts,
          attempt_count: attempts.length,
        };
      }
    }

    return {
      accepted: false,
      delivered: false,
      degraded: true,
      reason: finalReason,
      error: finalError,
      status: finalStatus,
      forwarded,
      attempts,
      attempt_count: attempts.length,
    };
  }

  private async attemptDelivery(
    callAdapter: () => Promise<AdapterDeliveryOutcome>,
    timeoutMs?: number | null,
  ): Promise<AdapterDeliveryOutcome & { reason: AdapterFailureReason | null }> {
    try {
      const outcome = await withTimeout(
        Promise.resolve().then(callAdapter),
        timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      if (outcome.accepted !== true) {
        return {
          accepted: false,
          forwarded: outcome.forwarded,
          reason: "adapter_rejected",
          error: outcome.error ?? "adapter did not accept delivery",
        };
      }

      return {
        accepted: true,
        forwarded: outcome.forwarded,
        reason: null,
        error: null,
      };
    } catch (error) {
      return {
        accepted: false,
        forwarded: false,
        reason: error instanceof CommunicationCoreM5TimeoutError ? "timeout" : "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export interface LoadProbeReport<T = unknown> {
  name: string;
  started_at: string;
  finished_at: string;
  total: number;
  accepted: number;
  duplicates: number;
  failed: number;
  peak_in_flight: number;
  concurrency: number;
  duration_ms: number;
  throughput_per_second: number;
  latency_ms: {
    min: number;
    avg: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };
  errors: Array<{ index: number; name: string; message: string }>;
  sample_results: T[];
}

@Injectable()
export class CommunicationCoreLoadProbeService {
  private ingressTotal = 0;
  private ingressAccepted = 0;
  private ingressDuplicates = 0;
  private ingressFailed = 0;
  private ingressLatenciesMs: number[] = [];
  private lastIngressReport: LoadProbeReport | null = null;

  startTimer(): () => number {
    const started = highResolutionNow();
    return () => Math.max(0, highResolutionNow() - started);
  }

  recordIngress(result: { accepted?: boolean; duplicate?: boolean } | null, durationMs: number): void {
    this.ingressTotal += 1;
    if (result?.accepted !== false) {
      this.ingressAccepted += 1;
    } else {
      this.ingressFailed += 1;
    }
    if (result?.duplicate === true) {
      this.ingressDuplicates += 1;
    }
    this.ingressLatenciesMs.push(durationMs);
    this.trimLatencyWindow();
  }

  recordIngressFailure(durationMs: number): void {
    this.ingressTotal += 1;
    this.ingressFailed += 1;
    this.ingressLatenciesMs.push(durationMs);
    this.trimLatencyWindow();
  }

  async runIngressProbe<TMessage, TResult>({
    name = "communication-core-ingress-routing",
    messages,
    concurrency = DEFAULT_CONCURRENCY,
    task,
    clock = () => new Date().toISOString(),
  }: {
    name?: string;
    messages: TMessage[];
    concurrency?: number;
    task: (message: TMessage, index: number) => Promise<TResult>;
    clock?: () => string;
  }): Promise<LoadProbeReport<TResult>> {
    const report = await runLoadProbe({
      name,
      items: messages,
      concurrency,
      clock,
      task,
      accepted: (result) => (result as { accepted?: boolean })?.accepted !== false,
      duplicate: (result) => (result as { duplicate?: boolean })?.duplicate === true,
    });
    this.lastIngressReport = report;

    return report;
  }

  getSignals(): {
    ingressTotal: number;
    ingressAccepted: number;
    ingressDuplicates: number;
    ingressFailed: number;
    ingressLatencyP95Ms: number;
    ingressLatencyMaxMs: number;
    lastIngressProbe: LoadProbeReport | null;
  } {
    const summary = latencySummary(this.ingressLatenciesMs);

    return {
      ingressTotal: this.ingressTotal,
      ingressAccepted: this.ingressAccepted,
      ingressDuplicates: this.ingressDuplicates,
      ingressFailed: this.ingressFailed,
      ingressLatencyP95Ms: summary.p95,
      ingressLatencyMaxMs: summary.max,
      lastIngressProbe: this.lastIngressReport,
    };
  }

  private trimLatencyWindow(): void {
    if (this.ingressLatenciesMs.length > 1000) {
      this.ingressLatenciesMs.splice(0, this.ingressLatenciesMs.length - 1000);
    }
  }
}

export async function runLoadProbe<TItem, TResult>({
  name,
  items,
  task,
  concurrency = DEFAULT_CONCURRENCY,
  clock = () => new Date().toISOString(),
  accepted = () => true,
  duplicate = () => false,
}: {
  name: string;
  items: TItem[];
  task: (item: TItem, index: number) => Promise<TResult>;
  concurrency?: number;
  clock?: () => string;
  accepted?: (result: TResult) => boolean;
  duplicate?: (result: TResult) => boolean;
}): Promise<LoadProbeReport<TResult>> {
  const startedAt = clock();
  const started = highResolutionNow();
  const latencies: number[] = [];
  const errors: Array<{ index: number; name: string; message: string }> = [];
  const sampleResults: TResult[] = [];
  let acceptedCount = 0;
  let duplicateCount = 0;
  let failedCount = 0;
  let nextIndex = 0;
  let inFlight = 0;
  let peakInFlight = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      const itemStarted = highResolutionNow();

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
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        latencies.push(Math.max(0, highResolutionNow() - itemStarted));
        inFlight -= 1;
      }
    }
  }

  const workerCount = Math.min(
    Math.max(1, Number(concurrency) || DEFAULT_CONCURRENCY),
    Math.max(1, items.length),
  );
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const durationMs = Math.max(0.001, highResolutionNow() - started);

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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new CommunicationCoreM5TimeoutError());
    }, Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function latencySummary(values: number[]): LoadProbeReport["latency_ms"] {
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
    max: round(sorted[sorted.length - 1]),
  };
}

function percentile(sorted: number[], rank: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * rank) - 1),
  );

  return sorted[index];
}

function highResolutionNow(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function round(value: number): number {
  return Math.round(Number(value) * 1000) / 1000;
}
