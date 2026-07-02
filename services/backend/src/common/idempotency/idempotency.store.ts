import { Inject, Injectable, Optional } from "@nestjs/common";

export type IdempotencyState = "pending" | "completed";

export interface IdempotencyEntry {
  createdAt: number;
  expiresAt: number;
  fingerprint: string;
  responseBody?: unknown;
  state: IdempotencyState;
  statusCode?: number;
}

export type IdempotencyReservation =
  | { entry: IdempotencyEntry; kind: "created" }
  | { entry: IdempotencyEntry; kind: "pending" }
  | { entry: IdempotencyEntry; kind: "replay" }
  | { entry: IdempotencyEntry; kind: "conflict" };

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_TTL_MS = Symbol("IDEMPOTENCY_TTL_MS");

@Injectable()
export class InMemoryIdempotencyStore {
  private readonly records = new Map<string, IdempotencyEntry>();
  private readonly ttlMs: number;

  constructor(@Optional() @Inject(IDEMPOTENCY_TTL_MS) ttlMs?: number) {
    this.ttlMs = ttlMs ?? DEFAULT_TTL_MS;
  }

  reserve(key: string, fingerprint: string): IdempotencyReservation {
    this.purgeExpired();

    const existingEntry = this.records.get(key);
    if (existingEntry) {
      if (existingEntry.fingerprint !== fingerprint) {
        return { entry: existingEntry, kind: "conflict" };
      }

      if (existingEntry.state === "completed") {
        return { entry: existingEntry, kind: "replay" };
      }

      return { entry: existingEntry, kind: "pending" };
    }

    const now = Date.now();
    const entry: IdempotencyEntry = {
      createdAt: now,
      expiresAt: now + this.ttlMs,
      fingerprint,
      state: "pending",
    };
    this.records.set(key, entry);

    return { entry, kind: "created" };
  }

  commit(key: string, fingerprint: string, statusCode: number, responseBody: unknown): void {
    const entry = this.records.get(key);
    if (!entry || entry.fingerprint !== fingerprint) {
      return;
    }

    entry.responseBody = responseBody;
    entry.statusCode = statusCode;
    entry.state = "completed";
  }

  release(key: string, fingerprint: string): void {
    const entry = this.records.get(key);
    if (entry?.fingerprint === fingerprint && entry.state === "pending") {
      this.records.delete(key);
    }
  }

  clear(): void {
    this.records.clear();
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.records.entries()) {
      if (entry.expiresAt <= now) {
        this.records.delete(key);
      }
    }
  }
}
