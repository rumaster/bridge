import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

import { C8_VERSION } from "../../../packages/contracts/src/c8.js";
import { createDeterministicBroadcastMock } from "./deterministic-broadcast.js";

export interface BroadcastPlatformGrpcServerOptions {
  broadcast?: ReturnType<typeof createDeterministicBroadcastMock>;
  protoPath?: string;
}

export interface StartBroadcastPlatformGrpcServerOptions
  extends BroadcastPlatformGrpcServerOptions {
  host?: string;
  port: number;
}

interface JsonResponse {
  json_payload: string;
}

type UnaryCallback = (error: grpc.ServiceError | null, response?: JsonResponse) => void;

export async function startBroadcastPlatformGrpcServer({
  broadcast,
  host = "0.0.0.0",
  port,
  protoPath,
}: StartBroadcastPlatformGrpcServerOptions): Promise<{
  address: string;
  port: number;
  server: grpc.Server;
}> {
  const server = createBroadcastPlatformGrpcServer({ broadcast, protoPath });
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

export function createBroadcastPlatformGrpcServer({
  broadcast = createDeterministicBroadcastMock(),
  protoPath,
}: BroadcastPlatformGrpcServerOptions = {}): grpc.Server {
  const server = new grpc.Server();

  server.addService(loadBroadcastPlatformService(protoPath), {
    CreateBroadcast: async (call, callback: UnaryCallback) => {
      await respond(callback, () => {
        const request = call.request ?? {};
        return broadcast.createBroadcast({
          contract: "C8.CreateBroadcastRequest",
          version: C8_VERSION,
          request_id: request.request_id,
          organization_id: request.organization_id,
          created_by: request.created_by,
          name: request.name,
          template: parseJsonObjectField(request.template_json, "template_json"),
          filter: parseJsonObjectField(request.filter_json, "filter_json"),
          schedule: parseJsonObjectField(request.schedule_json, "schedule_json"),
          rate_limit: parseJsonObjectField(request.rate_limit_json, "rate_limit_json"),
        });
      });
    },
    GetBroadcastStats: async (call, callback: UnaryCallback) => {
      await respond(callback, () => {
        const request = call.request ?? {};
        return broadcast.getStats({
          broadcastId: request.broadcast_id,
          organizationId: request.organization_id,
          requestId: request.request_id,
        });
      });
    },
    Health: async (_call, callback: UnaryCallback) => {
      await respond(callback, () => ({
        contract: "C8",
        mode: "grpc",
        service: "broadcast-platform",
        status: "ok",
      }));
    },
    ListBroadcasts: async (call, callback: UnaryCallback) => {
      await respond(callback, () => {
        const request = call.request ?? {};
        return broadcast.listBroadcasts({
          organizationId: request.organization_id,
          requestId: request.request_id,
        });
      });
    },
    StartBroadcast: async (call, callback: UnaryCallback) => {
      await respond(callback, () => {
        const request = call.request ?? {};
        return broadcast.startBroadcast(request.broadcast_id, {
          contract: "C8.StartBroadcastRequest",
          version: C8_VERSION,
          request_id: request.request_id,
          organization_id: request.organization_id,
          started_by: request.started_by,
          mode: request.mode || "immediate",
          scheduled_for: request.scheduled_for || undefined,
          idempotency_key: request.idempotency_key || request.request_id,
        });
      });
    },
  });

  return server;
}

function loadBroadcastPlatformService(protoPath?: string) {
  const packageDefinition = protoLoader.loadSync(resolveBroadcastProtoPath(protoPath), {
    defaults: true,
    enums: String,
    keepCase: true,
    longs: String,
    oneofs: true,
  });
  const descriptor = grpc.loadPackageDefinition(packageDefinition) as {
    bridge?: { broadcast?: { v1?: { BroadcastPlatform?: { service?: grpc.ServiceDefinition } } } };
  };
  const service = descriptor.bridge?.broadcast?.v1?.BroadcastPlatform?.service;
  if (!service) {
    throw new Error("BroadcastPlatform service is missing in C8 gRPC proto descriptor");
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
    throw new Error(`SVC-BCAST gRPC request requires ${field}`);
  }

  try {
    const parsed = JSON.parse(value);
    if (!isRecord(parsed)) {
      throw new Error("field must be a JSON object");
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SVC-BCAST gRPC request has invalid ${field}: ${message}`);
  }
}

function toGrpcError(error: unknown): grpc.ServiceError {
  const serviceError = new Error(
    error instanceof Error ? error.message : "SVC-BCAST gRPC request failed",
  ) as grpc.ServiceError;
  serviceError.code = grpc.status.INTERNAL;
  return serviceError;
}

function resolveBroadcastProtoPath(explicitProtoPath?: string): string {
  const moduleDir = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    explicitProtoPath,
    resolve(process.cwd(), "packages/contracts/proto/broadcasts/c8.broadcast.proto"),
    resolve(process.cwd(), "../../packages/contracts/proto/broadcasts/c8.broadcast.proto"),
    resolve(moduleDir, "../../../packages/contracts/proto/broadcasts/c8.broadcast.proto"),
    resolve(moduleDir, "../../../../packages/contracts/proto/broadcasts/c8.broadcast.proto"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const protoPath = candidates.find((candidate) => existsSync(candidate));
  if (!protoPath) {
    throw new Error(`Unable to locate C8 gRPC proto. Checked: ${candidates.join(", ")}`);
  }

  return protoPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
