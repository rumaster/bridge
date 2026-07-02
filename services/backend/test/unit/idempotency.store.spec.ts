import { InMemoryIdempotencyStore } from "../../src/common/idempotency/idempotency.store";

describe("InMemoryIdempotencyStore", () => {
  it("reserves a key, commits a response and replays it for the same fingerprint", () => {
    const store = new InMemoryIdempotencyStore();

    expect(store.reserve("key-1", "fingerprint-1").kind).toBe("created");
    store.commit("key-1", "fingerprint-1", 201, { id: "message-1" });

    expect(store.reserve("key-1", "fingerprint-1")).toMatchObject({
      entry: { responseBody: { id: "message-1" }, statusCode: 201 },
      kind: "replay",
    });
  });

  it("rejects a reused key with a different request fingerprint", () => {
    const store = new InMemoryIdempotencyStore();

    expect(store.reserve("key-1", "fingerprint-1").kind).toBe("created");

    expect(store.reserve("key-1", "fingerprint-2").kind).toBe("conflict");
  });

  it("releases pending keys after handler failures", () => {
    const store = new InMemoryIdempotencyStore();

    expect(store.reserve("key-1", "fingerprint-1").kind).toBe("created");
    store.release("key-1", "fingerprint-1");

    expect(store.reserve("key-1", "fingerprint-1").kind).toBe("created");
  });
});
