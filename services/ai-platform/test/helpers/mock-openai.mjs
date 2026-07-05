/**
 * Test helper: a mock `fetchImpl` for the OpenAI-compatible providers.
 *
 * The providers (openai-provider.mjs, azure-provider.mjs, openai-compatible.mjs)
 * take their `fetch` by dependency injection, so these helpers let the unit tests
 * assert on the exact URL, headers and JSON body sent — and control the response —
 * without ever touching the network. Mirrors the in-memory-double style the
 * integration tests use for the Knowledge Base search.
 */

const CHAT_PATH = "/chat/completions";
const EMBEDDINGS_PATH = "/embeddings";

/** A JSON `Response`-like object exposing only what the provider core reads. */
export function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      if (payload instanceof Error) {
        throw payload;
      }
      return payload;
    },
    async text() {
      return typeof payload === "string" ? payload : JSON.stringify(payload);
    },
  };
}

/** An embeddings API payload carrying a vector of the given length (default 1536). */
export function embeddingPayload(length = 1536, fill = 0.001) {
  return { data: [{ embedding: Array.from({ length }, () => fill) }] };
}

/** A chat-completions API payload whose single choice carries `content`. */
export function chatPayload(content) {
  return { choices: [{ message: { content } }] };
}

/**
 * Build a mock `fetchImpl`. `handler(url, call, callIndex)` returns either a
 * payload (wrapped in a 200 JSON response) or a full `jsonResponse(...)`. The
 * returned function exposes `.calls` — one `{ url, method, headers, body }` per
 * call, with `body` already JSON-parsed.
 */
export function createMockFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method,
      headers: init.headers ?? {},
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
      signal: init.signal,
    };
    calls.push(call);
    const outcome = await handler(call.url, call, calls.length - 1);
    return isResponse(outcome) ? outcome : jsonResponse(outcome);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/**
 * Convenience: route by URL path to a fixed embeddings/chat outcome. Each of
 * `{ embedding, chat }` is a payload or a `jsonResponse(...)`.
 */
export function routeByPath({ embedding, chat } = {}) {
  return createMockFetch((url) => {
    if (url.includes(EMBEDDINGS_PATH)) {
      return embedding;
    }
    if (url.includes(CHAT_PATH)) {
      return chat;
    }
    throw new Error(`mock fetch received an unexpected URL: ${url}`);
  });
}

function isResponse(value) {
  return value !== null && typeof value === "object" && typeof value.json === "function";
}
