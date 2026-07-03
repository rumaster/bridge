import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BridgeApiError,
  createJsonApiClient,
  normalizeBaseUrl,
  resolveApiUrl,
} from "../src/index.mjs";

describe("@bridge/api-client JSON helper", () => {
  it("resolves relative API paths against the configured base URL", () => {
    assert.equal(
      resolveApiUrl("/api/v1/", "/messages", "https://bridge.example"),
      "https://bridge.example/api/v1/messages",
    );
    assert.equal(normalizeBaseUrl("/api/v1///"), "/api/v1");
  });

  it("sends JSON requests through the injected fetcher", async () => {
    const calls = [];
    const api = createJsonApiClient({
      baseUrl: "/api/v1",
      origin: "https://bridge.example",
      fetcher: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await assert.doesNotReject(api.requestJson("/health"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://bridge.example/api/v1/health");
    assert.equal(calls[0].init.headers.get("accept"), "application/json");
  });

  it("raises BridgeApiError with parsed error body", async () => {
    const api = createJsonApiClient({
      fetcher: async () =>
        new Response(JSON.stringify({ message: "denied" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    });

    await assert.rejects(api.requestJson("/secure"), (error) => {
      assert.ok(error instanceof BridgeApiError);
      assert.equal(error.status, 403);
      assert.deepEqual(error.body, { message: "denied" });
      assert.equal(error.message, "denied");
      return true;
    });
  });

  it("uses Problem Details detail as the BridgeApiError message", async () => {
    const api = createJsonApiClient({
      fetcher: async () =>
        new Response(
          JSON.stringify({
            type: "https://bridge.local/problems/validation-error",
            title: "Validation failed",
            status: 400,
            detail: "Request payload does not match C3.org DTO.",
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        ),
    });

    await assert.rejects(api.requestJson("/organizations/org-demo/configuration"), (error) => {
      assert.ok(error instanceof BridgeApiError);
      assert.equal(error.message, "Request payload does not match C3.org DTO.");
      return true;
    });
  });
});
