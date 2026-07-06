import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

export interface AiPlatformGrpcServerOptions {
  ai: any;
  protoPath?: string;
}

export interface StartAiPlatformGrpcServerOptions extends AiPlatformGrpcServerOptions {
  host?: string;
  port: number;
}

interface JsonResponse {
  json_payload: string;
}

type UnaryCallback = (error: grpc.ServiceError | null, response?: JsonResponse) => void;

export async function startAiPlatformGrpcServer({
  ai,
  host = "0.0.0.0",
  port,
  protoPath,
}: StartAiPlatformGrpcServerOptions): Promise<{
  address: string;
  port: number;
  server: grpc.Server;
}> {
  const server = createAiPlatformGrpcServer({ ai, protoPath });
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

export function createAiPlatformGrpcServer({
  ai,
  protoPath,
}: AiPlatformGrpcServerOptions): grpc.Server {
  const server = new grpc.Server();
  server.addService(loadAiPlatformService(protoPath), {
    CreateOnboardingCommand: async (call, callback: UnaryCallback) => {
      await respond(callback, () => ai.createOnboardingCommand(call.request));
    },
    Health: async (_call, callback: UnaryCallback) => {
      await respond(callback, () => {
        const base = {
          contract: "C4",
          mode: ai.mode ?? "grpc",
          service: "ai-platform",
          status: "ok",
        };
        const health = typeof ai.getHealth === "function" ? ai.getHealth() : {};
        return { ...base, ...health };
      });
    },
    SuggestAssistant: async (call, callback: UnaryCallback) => {
      await respond(callback, () => ai.suggestAssistant(call.request));
    },
  });

  return server;
}

function loadAiPlatformService(protoPath?: string) {
  const packageDefinition = protoLoader.loadSync(resolveAiProtoPath(protoPath), {
    defaults: true,
    enums: String,
    keepCase: true,
    longs: String,
    oneofs: true,
  });
  const descriptor = grpc.loadPackageDefinition(packageDefinition) as {
    bridge?: { ai?: { v1?: { AiPlatform?: { service?: grpc.ServiceDefinition } } } };
  };
  const service = descriptor.bridge?.ai?.v1?.AiPlatform?.service;
  if (!service) {
    throw new Error("AiPlatform service is missing in C4 gRPC proto descriptor");
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

function toGrpcError(error: unknown): grpc.ServiceError {
  const serviceError = new Error(
    error instanceof Error ? error.message : "SVC-AI gRPC request failed",
  ) as grpc.ServiceError;
  serviceError.code = grpc.status.INTERNAL;
  return serviceError;
}

function resolveAiProtoPath(explicitProtoPath?: string): string {
  const moduleDir = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    explicitProtoPath,
    resolve(process.cwd(), "packages/contracts/proto/ai/c4.ai.proto"),
    resolve(process.cwd(), "../../packages/contracts/proto/ai/c4.ai.proto"),
    resolve(moduleDir, "../../../packages/contracts/proto/ai/c4.ai.proto"),
    resolve(moduleDir, "../../../../packages/contracts/proto/ai/c4.ai.proto"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const protoPath = candidates.find((candidate) => existsSync(candidate));
  if (!protoPath) {
    throw new Error(
      `Unable to locate C4 gRPC proto. Checked: ${candidates.join(", ")}`,
    );
  }

  return protoPath;
}
