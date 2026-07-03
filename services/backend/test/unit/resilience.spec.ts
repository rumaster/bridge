import {
  Bulkhead,
  CircuitBreaker,
  FacadeResilience,
  FacadeTimeoutError,
  withTimeout,
} from "../../src/common/resilience/resilience";

describe("CircuitBreaker", () => {
  it("starts closed and stays closed while calls succeed", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });

    for (let i = 0; i < 10; i += 1) {
      expect(breaker.tryAcquire().allowed).toBe(true);
      breaker.onSuccess();
    }

    expect(breaker.getState()).toBe("closed");
  });

  it("opens after the failure threshold and rejects further calls fast", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });

    for (let i = 0; i < 3; i += 1) {
      expect(breaker.tryAcquire().allowed).toBe(true);
      breaker.onFailure();
    }

    expect(breaker.getState()).toBe("open");
    const rejected = breaker.tryAcquire();
    expect(rejected).toEqual({ allowed: false, reason: "circuit_open" });
  });

  it("resets a closed failure streak after any success", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });

    breaker.tryAcquire();
    breaker.onFailure();
    breaker.tryAcquire();
    breaker.onFailure();
    breaker.tryAcquire();
    breaker.onSuccess();
    breaker.tryAcquire();
    breaker.onFailure();

    expect(breaker.getState()).toBe("closed");
  });

  it("transitions open → half-open after the reset timeout elapses", () => {
    let clock = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 500,
      now: () => clock,
    });

    breaker.tryAcquire();
    breaker.onFailure();
    expect(breaker.getState()).toBe("open");

    clock = 499;
    expect(breaker.getState()).toBe("open");

    clock = 500;
    expect(breaker.getState()).toBe("half_open");
  });

  it("closes from half-open after enough trial successes", () => {
    let clock = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      successThreshold: 2,
      resetTimeoutMs: 100,
      halfOpenMaxCalls: 1,
      now: () => clock,
    });

    breaker.tryAcquire();
    breaker.onFailure();
    clock = 100;

    expect(breaker.tryAcquire().allowed).toBe(true);
    breaker.onSuccess();
    expect(breaker.getState()).toBe("half_open");

    expect(breaker.tryAcquire().allowed).toBe(true);
    breaker.onSuccess();
    expect(breaker.getState()).toBe("closed");
  });

  it("re-opens from half-open when a trial call fails", () => {
    let clock = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 100,
      now: () => clock,
    });

    breaker.tryAcquire();
    breaker.onFailure();
    clock = 100;
    expect(breaker.getState()).toBe("half_open");

    expect(breaker.tryAcquire().allowed).toBe(true);
    breaker.onFailure();
    expect(breaker.getState()).toBe("open");
  });

  it("limits concurrent trial calls while half-open", () => {
    let clock = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 100,
      halfOpenMaxCalls: 1,
      now: () => clock,
    });

    breaker.tryAcquire();
    breaker.onFailure();
    clock = 100;

    expect(breaker.tryAcquire().allowed).toBe(true);
    // A second concurrent trial is refused until the first settles.
    expect(breaker.tryAcquire()).toEqual({ allowed: false, reason: "circuit_open" });
  });
});

describe("Bulkhead", () => {
  it("admits up to maxConcurrent calls immediately", async () => {
    const bulkhead = new Bulkhead({ maxConcurrent: 2, maxQueue: 0 });

    await expect(bulkhead.acquire()).resolves.toBe(true);
    await expect(bulkhead.acquire()).resolves.toBe(true);
    expect(bulkhead.activeCount).toBe(2);
  });

  it("rejects calls beyond concurrency + queue capacity", async () => {
    const bulkhead = new Bulkhead({ maxConcurrent: 1, maxQueue: 1 });

    await expect(bulkhead.acquire()).resolves.toBe(true); // active
    const queued = bulkhead.acquire(); // queued
    await expect(bulkhead.acquire()).resolves.toBe(false); // rejected — queue full
    expect(bulkhead.queuedCount).toBe(1);

    bulkhead.release(); // hands the slot to the queued waiter
    await expect(queued).resolves.toBe(true);
  });

  it("frees a slot on release when nothing is queued", async () => {
    const bulkhead = new Bulkhead({ maxConcurrent: 1, maxQueue: 0 });

    await bulkhead.acquire();
    expect(bulkhead.activeCount).toBe(1);
    bulkhead.release();
    expect(bulkhead.activeCount).toBe(0);
    await expect(bulkhead.acquire()).resolves.toBe(true);
  });
});

describe("withTimeout", () => {
  it("resolves fast calls unchanged", async () => {
    await expect(withTimeout(Promise.resolve("value"), 50)).resolves.toBe("value");
  });

  it("rejects with FacadeTimeoutError when the call is too slow", async () => {
    await expect(withTimeout(new Promise(() => undefined), 1)).rejects.toBeInstanceOf(
      FacadeTimeoutError,
    );
  });
});

describe("FacadeResilience", () => {
  it("returns no_client when no call is provided", async () => {
    const resilience = new FacadeResilience();
    await expect(resilience.execute(undefined)).resolves.toEqual({
      ok: false,
      reason: "no_client",
    });
  });

  it("passes through a successful call result", async () => {
    const resilience = new FacadeResilience();
    await expect(resilience.execute(async () => 42)).resolves.toEqual({ ok: true, value: 42 });
  });

  it("reports a timeout outcome without throwing", async () => {
    const resilience = new FacadeResilience({ defaultTimeoutMs: 1 });
    await expect(resilience.execute(() => new Promise(() => undefined))).resolves.toMatchObject({
      ok: false,
      reason: "timeout",
    });
  });

  it("reports an error outcome when the call rejects", async () => {
    const resilience = new FacadeResilience();
    await expect(
      resilience.execute(async () => {
        throw new Error("boom");
      }),
    ).resolves.toMatchObject({ ok: false, reason: "error" });
  });

  it("short-circuits with circuit_open once the breaker trips", async () => {
    const resilience = new FacadeResilience({
      circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 10_000 },
    });

    const failing = async (): Promise<number> => {
      throw new Error("upstream down");
    };
    await resilience.execute(failing);
    await resilience.execute(failing);

    const outcome = await resilience.execute(async () => 1);
    expect(outcome).toEqual({ ok: false, reason: "circuit_open" });
    expect(resilience.circuitState).toBe("open");
  });

  it("rejects with bulkhead_full when concurrency and queue are saturated", async () => {
    const resilience = new FacadeResilience({
      bulkhead: { maxConcurrent: 1, maxQueue: 0 },
    });

    let release: (() => void) | undefined;
    const blocker = new Promise<number>((resolve) => {
      release = () => resolve(1);
    });

    const inflight = resilience.execute(() => blocker);
    // Give the in-flight call a tick to reserve the only slot.
    await Promise.resolve();

    const rejected = await resilience.execute(async () => 2);
    expect(rejected).toEqual({ ok: false, reason: "bulkhead_full" });

    release?.();
    await expect(inflight).resolves.toEqual({ ok: true, value: 1 });
  });
});
