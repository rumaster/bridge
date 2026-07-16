import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

import { C5_VERSION, createWorkflowStateChangedEvent } from "../../../packages/contracts/src/c5.js";
import type { BackendApiClient } from "./backend/client.js";
import { createFbpEngine } from "./engine.js";

export interface FbpEngineGrpcServerOptions {
  backendClient: BackendApiClient;
  now?: () => string;
  protoPath?: string;
}

export interface StartFbpEngineGrpcServerOptions extends FbpEngineGrpcServerOptions {
  host?: string;
  port: number;
}

interface JsonResponse {
  json_payload: string;
}

type UnaryCallback = (error: grpc.ServiceError | null, response?: JsonResponse) => void;

export async function startFbpEngineGrpcServer({
  backendClient,
  host = "0.0.0.0",
  now,
  port,
  protoPath,
}: StartFbpEngineGrpcServerOptions): Promise<{
  address: string;
  port: number;
  server: grpc.Server;
}> {
  const server = createFbpEngineGrpcServer({ backendClient, now, protoPath });
  const address = `${host}:${port}`;
  const boundPort = await new Promise<number>((resolvePort, reject) => {
    server.bindAsync(address, grpc.ServerCredentials.createInsecure(), (error, actualPort) => {
      if (error) {
        reject(error);
        return;
      }
      resolvePort(actualPort);
    });
  });

  return {
    address: `${host}:${boundPort}`,
    port: boundPort,
    server,
  };
}

export function createFbpEngineGrpcServer({
  backendClient,
  now = () => new Date().toISOString(),
  protoPath,
}: FbpEngineGrpcServerOptions): grpc.Server {
  const engine = createFbpEngine({ backendClient, now });
  const server = new grpc.Server();

  server.addService(loadFbpEngineService(protoPath), {
    Health: async (_call, callback: UnaryCallback) => {
      await respond(callback, () => ({
        contract: "C5",
        mode: "grpc",
        service: "fbp-engine",
        status: "ok",
      }));
    },
    /**
     * Тест-прогон драфта (дефект D5, решение A5).
     *
     * Драфт исполняется НАСТОЯЩИМ движком, но экземпляра не создаёт: ни записи в
     * `workflow_instances`, ни события смены состояния. Это и позволяет гонять его
     * над недостроенной схемой — журнал исполнения ссылается на инстанс внешним
     * ключом, а тестового инстанса нет.
     *
     * Возвращается трасса по узлам, а не журнал: журнал Backend сохраняет, а трасса
     * нужна редактору, чтобы подсветить пройденный путь. Трасса приходит и при
     * падении — именно тогда она и нужна.
     */
    TestWorkflowDraft: async (call, callback: UnaryCallback) => {
      await respond(callback, async () => {
        const request = call.request ?? {};
        const schema = parseJsonObjectField(request.schema_json, "schema_json");
        const context = parseJsonObjectField(request.context_json || "{}", "context_json");
        const eventPayload = parseJsonObjectField(
          request.event_payload_json || "{}",
          "event_payload_json",
        );
        const startNodeId = String(request.start_node_id ?? "").trim();

        if (startNodeId === "") {
          throw new Error(
            "TestWorkflowDraft требует start_node_id — точка входа схемы 2.0 — узел «Ожидание события».",
          );
        }

        const result = await engine.runWorkflow({
          context: { ...context, organization_id: request.organization_id },
          // Полезная нагрузка события — это вход прогона: узел «Ожидание события»
          // отдаёт её портом data.
          input: eventPayload,
          schema,
          startNodeId,
          // Идентификатор фиктивный и в базу не попадает; он нужен только контексту
          // исполнения. Префикс делает его отличимым в логах от боевого.
          instanceId: `draft-test:${request.request_id}`,
        });

        return {
          contract: "C5.TestWorkflowDraftResponse",
          version: C5_VERSION,
          request_id: request.request_id,
          organization_id: request.organization_id,
          workflow_id: request.workflow_id,
          status: result.status ?? "failed",
          output: result.output ?? null,
          error: result.error ?? null,
          trace: result.trace ?? [],
          created_at: now(),
        };
      });
    },
    StartWorkflowInstance: async (call, callback: UnaryCallback) => {
      await respond(callback, async () => {
        const request = call.request ?? {};
        const schema = parseJsonObjectField(request.schema_json, "schema_json");
        const context = parseJsonObjectField(request.context_json, "context_json");
        const input = parseJsonObjectField(request.input_json || "{}", "input_json");
        // Узел-триггер едет в context_json, а не отдельным полем proto: с ревизии
        // 2026-07-15 точка входа — сработавший узел «Ожидание события», и это часть
        // контекста запуска наравне с trigger/actor. Так проводной контракт C5
        // остаётся замороженным на 1.0.0 — новых полей в сообщении не появляется.
        const result = await engine.runWorkflow({
          context,
          input,
          schema,
          startNodeId: typeof context.start_node_id === "string" ? context.start_node_id : undefined,
        });
        const createdAt = now();
        const status = result.status ?? "failed";

        return {
          contract: "C5.StartWorkflowInstanceResponse",
          version: C5_VERSION,
          request_id: request.request_id,
          organization_id: request.organization_id,
          workflow_id: request.workflow_id,
          workflow_version_id: request.workflow_version_id,
          instance_id: result.instance_id,
          status,
          degraded: false,
          fallback_reason: null,
          state: {
            error: result.error ?? null,
            input,
            output: result.output ?? null,
            status,
          },
          state_changed_event: createWorkflowStateChangedEvent({
            changedAt: createdAt,
            eventId: `${result.instance_id}:${status}`,
            instanceId: result.instance_id,
            organizationId: request.organization_id,
            previousStatus: "running",
            reason: "real_engine",
            status,
            workflowId: request.workflow_id,
            workflowVersionId: request.workflow_version_id,
          }),
          created_at: createdAt,
          journal: result.journal ?? [],
        };
      });
    },
  });

  return server;
}

function loadFbpEngineService(protoPath?: string) {
  const packageDefinition = protoLoader.loadSync(resolveFbpProtoPath(protoPath), {
    defaults: true,
    enums: String,
    keepCase: true,
    longs: String,
    oneofs: true,
  });
  const descriptor = grpc.loadPackageDefinition(packageDefinition) as {
    bridge?: { fbp?: { v1?: { FbpEngine?: { service?: grpc.ServiceDefinition } } } };
  };
  const service = descriptor.bridge?.fbp?.v1?.FbpEngine?.service;
  if (!service) {
    throw new Error("FbpEngine service is missing in C5 gRPC proto descriptor");
  }

  return service;
}

async function respond(callback: UnaryCallback, payload: () => unknown): Promise<void> {
  try {
    callback(null, { json_payload: JSON.stringify(await payload()) });
  } catch (error) {
    callback(toGrpcError(error));
  }
}

function parseJsonObjectField(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`SVC-FBP gRPC request requires ${field}`);
  }

  try {
    const parsed = JSON.parse(value);
    if (!isRecord(parsed)) {
      throw new Error("field must be a JSON object");
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SVC-FBP gRPC request has invalid ${field}: ${message}`);
  }
}

function toGrpcError(error: unknown): grpc.ServiceError {
  const serviceError = new Error(
    error instanceof Error ? error.message : "SVC-FBP gRPC request failed",
  ) as grpc.ServiceError;
  serviceError.code = grpc.status.INTERNAL;
  return serviceError;
}

function resolveFbpProtoPath(explicitProtoPath?: string): string {
  const moduleDir = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    explicitProtoPath,
    resolve(process.cwd(), "packages/contracts/proto/fbp/c5.fbp.proto"),
    resolve(process.cwd(), "../../packages/contracts/proto/fbp/c5.fbp.proto"),
    resolve(moduleDir, "../../../packages/contracts/proto/fbp/c5.fbp.proto"),
    resolve(moduleDir, "../../../../packages/contracts/proto/fbp/c5.fbp.proto"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const proto = candidates.find((candidate) => existsSync(candidate));
  if (!proto) {
    throw new Error(`Unable to locate C5 gRPC proto. Checked: ${candidates.join(", ")}`);
  }

  return proto;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
