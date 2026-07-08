import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";

import { TRANSFORM_DEFAULT_LIMITS } from "../../../../packages/contracts/src/c5.js";
import { TransformEvaluationError } from "./errors.js";

interface TransformCodeLimits {
  codeMemoryMb?: number;
  codeTimeoutMs?: number;
  maxCodeLength?: number;
  maxResultBytes?: number;
}

interface SandboxResponse {
  message?: string;
  ok: boolean;
  reason?: string;
  result?: unknown;
}

const RUNNER_SOURCE = String.raw`
import vm from "node:vm";

const hiddenGlobals = [
  "Atomics",
  "Buffer",
  "Date",
  "Function",
  "SharedArrayBuffer",
  "WebAssembly",
  "clearImmediate",
  "clearInterval",
  "clearTimeout",
  "console",
  "eval",
  "fetch",
  "queueMicrotask",
  "require",
  "setImmediate",
  "setInterval",
  "setTimeout"
];

const safeMathKeys = [
  "E",
  "LN10",
  "LN2",
  "LOG10E",
  "LOG2E",
  "PI",
  "SQRT1_2",
  "SQRT2",
  "abs",
  "acos",
  "acosh",
  "asin",
  "asinh",
  "atan",
  "atan2",
  "atanh",
  "cbrt",
  "ceil",
  "clz32",
  "cos",
  "cosh",
  "exp",
  "expm1",
  "floor",
  "fround",
  "hypot",
  "imul",
  "log",
  "log10",
  "log1p",
  "log2",
  "max",
  "min",
  "pow",
  "round",
  "sign",
  "sin",
  "sinh",
  "sqrt",
  "tan",
  "tanh",
  "trunc"
];

const chunks = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", async () => {
  try {
    const request = JSON.parse(chunks.join(""));
    const timeoutMs = normalizeInteger(request.timeoutMs, 200, 1, 30_000);
    const maxResultBytes = normalizeInteger(request.maxResultBytes, 262_144, 1, 16 * 1024 * 1024);
    const code = typeof request.code === "string" ? request.code : "";
    const inputJson = JSON.stringify(request.input ?? null);

    const context = vm.createContext(Object.create(null), {
      codeGeneration: { strings: false, wasm: false },
      name: "bridge-transform-code"
    });

    Object.defineProperty(context, "__bridgeInputJson", {
      configurable: true,
      value: inputJson,
      writable: false
    });

    new vm.Script(createBootstrapSource(), {
      displayErrors: false,
      filename: "transform-code-bootstrap.vm.js"
    }).runInContext(context, { displayErrors: false, timeout: timeoutMs });

    const script = new vm.Script('"use strict";\n(async () => {\n' + code + '\n})()', {
      displayErrors: false,
      filename: "transform-code.vm.js"
    });
    const value = await script.runInContext(context, { displayErrors: false, timeout: timeoutMs });
    const serialized = serializeResult(context, value, timeoutMs);

    if (serialized === undefined) {
      writeResponse({
        ok: false,
        reason: "result_not_serializable",
        message: "Transform code returned a non-JSON-serializable value."
      });
      return;
    }

    if (Buffer.byteLength(serialized, "utf8") > maxResultBytes) {
      writeResponse({
        ok: false,
        reason: "result_too_large",
        message: "Transform code result exceeds maxResultBytes."
      });
      return;
    }

    process.stdout.write('{"ok":true,"result":' + serialized + '}');
  } catch (error) {
    writeResponse({
      ok: false,
      reason: mapErrorReason(error),
      message: normalizeErrorMessage(error)
    });
  }
});

function writeResponse(response) {
  process.stdout.write(JSON.stringify(response));
}

function createBootstrapSource() {
  return [
    '"use strict";',
    "function hideGlobal(name) {",
    "  try {",
    "    Object.defineProperty(globalThis, name, { configurable: false, enumerable: false, value: undefined, writable: false });",
    "  } catch {",
    "    try { globalThis[name] = undefined; } catch {}",
    "  }",
    "}",
    "function hardenInput(value, seen = new Set()) {",
    "  if (value === null || typeof value !== 'object' || seen.has(value)) return value;",
    "  seen.add(value);",
    "  for (const key of Object.keys(value)) value[key] = hardenInput(value[key], seen);",
    "  if (!Array.isArray(value)) Object.setPrototypeOf(value, null);",
    "  return Object.freeze(value);",
    "}",
    "const originalMath = Math;",
    "const safeMath = Object.create(null);",
    "for (const key of " + JSON.stringify(safeMathKeys) + ") {",
    "  const descriptor = Object.getOwnPropertyDescriptor(originalMath, key);",
    "  if (descriptor) {",
    "    Object.defineProperty(safeMath, key, { configurable: false, enumerable: true, value: descriptor.value, writable: false });",
    "  }",
    "}",
    "Object.freeze(safeMath);",
    "Object.defineProperty(globalThis, 'Math', { configurable: false, enumerable: false, value: safeMath, writable: false });",
    "for (const key of " + JSON.stringify(hiddenGlobals) + ") hideGlobal(key);",
    "Object.defineProperty(globalThis, 'input', {",
    "  configurable: false,",
    "  enumerable: true,",
    "  value: hardenInput(JSON.parse(__bridgeInputJson)),",
    "  writable: false",
    "});",
    "delete globalThis.__bridgeInputJson;"
  ].join("\n");
}

function serializeResult(context, value, timeoutMs) {
  Object.defineProperty(context, "__bridgeResult", {
    configurable: true,
    value,
    writable: false
  });
  try {
    return new vm.Script("JSON.stringify(__bridgeResult)", {
      displayErrors: false,
      filename: "transform-code-serialize.vm.js"
    }).runInContext(context, { displayErrors: false, timeout: timeoutMs });
  } finally {
    delete context.__bridgeResult;
  }
}

function normalizeInteger(value, fallback, min, max) {
  const candidate = Number.isInteger(value) ? value : fallback;
  return Math.min(Math.max(candidate, min), max);
}

function mapErrorReason(error) {
  const message = normalizeErrorMessage(error);
  if (error?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" || /Script execution timed out/.test(message)) {
    return "code_timeout";
  }
  if (error instanceof SyntaxError) {
    return "code_syntax_error";
  }
  return "code_execution_failed";
}

function normalizeErrorMessage(error) {
  if (error instanceof Error && typeof error.message === "string" && error.message !== "") {
    return error.message;
  }
  return String(error);
}
`;

const DEFAULT_CODE_TIMEOUT_MS = 200;
const DEFAULT_CODE_MEMORY_MB = 16;
const DEFAULT_MAX_CODE_LENGTH = 65_536;
const MAX_STDERR_BYTES = 16_384;
const SANDBOX_WATCHDOG_GRACE_MS = 500;

export async function evaluateTransformCode(
  code: string,
  input: unknown,
  limits: TransformCodeLimits = {},
): Promise<unknown> {
  const maxCodeLength = normalizeLimit(limits.maxCodeLength, TRANSFORM_DEFAULT_LIMITS.maxCodeLength, {
    fallback: DEFAULT_MAX_CODE_LENGTH,
    max: 1024 * 1024,
    min: 1,
  });
  if (Buffer.byteLength(code, "utf8") > maxCodeLength) {
    throw new TransformEvaluationError("code_too_large", "Transform code exceeds maxCodeLength.");
  }

  const timeoutMs = normalizeLimit(limits.codeTimeoutMs, TRANSFORM_DEFAULT_LIMITS.codeTimeoutMs, {
    fallback: DEFAULT_CODE_TIMEOUT_MS,
    max: 30_000,
    min: 1,
  });
  const memoryMb = normalizeLimit(limits.codeMemoryMb, TRANSFORM_DEFAULT_LIMITS.codeMemoryMb, {
    fallback: DEFAULT_CODE_MEMORY_MB,
    max: 512,
    min: 8,
  });
  const maxResultBytes = normalizeLimit(limits.maxResultBytes, TRANSFORM_DEFAULT_LIMITS.maxResultBytes, {
    fallback: TRANSFORM_DEFAULT_LIMITS.maxResultBytes,
    max: 16 * 1024 * 1024,
    min: 1,
  });

  let payload: string;
  try {
    payload = JSON.stringify({ code, input, maxResultBytes, timeoutMs });
  } catch (error) {
    throw new TransformEvaluationError("input_not_serializable", normalizeErrorMessage(error));
  }

  return runSandboxProcess(payload, {
    maxStdoutBytes: maxResultBytes + 8_192,
    memoryMb,
    timeoutMs,
  });
}

function runSandboxProcess(
  payload: string,
  {
    maxStdoutBytes,
    memoryMb,
    timeoutMs,
  }: {
    maxStdoutBytes: number;
    memoryMb: number;
    timeoutMs: number;
  },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [`--max-old-space-size=${memoryMb}`, "--input-type=module", "--eval", RUNNER_SOURCE],
      {
        env: {},
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const watchdog = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs + SANDBOX_WATCHDOG_GRACE_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > maxStdoutBytes && !settled) {
        settled = true;
        child.kill("SIGKILL");
        clearTimeout(watchdog);
        reject(new TransformEvaluationError("result_too_large", "Transform code result exceeds maxResultBytes."));
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (Buffer.byteLength(stderr, "utf8") < MAX_STDERR_BYTES) {
        stderr += chunk;
      }
    });

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(watchdog);
      reject(new TransformEvaluationError("sandbox_start_failed", error.message));
    });

    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(watchdog);

      if (timedOut) {
        reject(new TransformEvaluationError("code_timeout", "Transform code execution timed out."));
        return;
      }

      const response = parseSandboxResponse(stdout, code, signal, stderr);
      if (!response.ok) {
        reject(new TransformEvaluationError(response.reason ?? "code_execution_failed", response.message));
        return;
      }
      resolve(response.result);
    });

    child.stdin.end(payload);
  });
}

function parseSandboxResponse(
  stdout: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): SandboxResponse {
  if (stdout.trim() === "") {
    return {
      message: stderr.trim() || `Sandbox process exited without response (code=${code}, signal=${signal}).`,
      ok: false,
      reason: "code_execution_failed",
    };
  }

  try {
    return JSON.parse(stdout) as SandboxResponse;
  } catch (error) {
    return {
      message: `Sandbox returned malformed response: ${normalizeErrorMessage(error)}`,
      ok: false,
      reason: "code_execution_failed",
    };
  }
}

function normalizeLimit(
  value: number | undefined,
  defaultValue: number | undefined,
  {
    fallback,
    max,
    min,
  }: {
    fallback: number;
    max: number;
    min: number;
  },
): number {
  const candidate = Number.isInteger(value) ? value : Number.isInteger(defaultValue) ? defaultValue : fallback;
  return Math.min(Math.max(candidate, min), max);
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  return String(error);
}
