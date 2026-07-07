import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

import { C10_VERSION } from "../../../packages/contracts/src/c10.js";
import { createDeterministicNotificationMock } from "./deterministic-notification.js";

export interface NotificationPlatformGrpcServerOptions {
  notifications?: ReturnType<typeof createDeterministicNotificationMock>;
  protoPath?: string;
}

export interface StartNotificationPlatformGrpcServerOptions
  extends NotificationPlatformGrpcServerOptions {
  host?: string;
  port: number;
}

interface JsonResponse {
  json_payload: string;
}

type UnaryCallback = (error: grpc.ServiceError | null, response?: JsonResponse) => void;

export async function startNotificationPlatformGrpcServer({
  host = "0.0.0.0",
  notifications,
  port,
  protoPath,
}: StartNotificationPlatformGrpcServerOptions): Promise<{
  address: string;
  port: number;
  server: grpc.Server;
}> {
  const server = createNotificationPlatformGrpcServer({ notifications, protoPath });
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

export function createNotificationPlatformGrpcServer({
  notifications = createDeterministicNotificationMock(),
  protoPath,
}: NotificationPlatformGrpcServerOptions = {}): grpc.Server {
  const server = new grpc.Server();

  server.addService(loadNotificationPlatformService(protoPath), {
    AcceptNotificationTrigger: async (call, callback: UnaryCallback) => {
      await respond(callback, () => {
        const request = call.request ?? {};
        return notifications.acceptProducerEvent(
          parseJsonObjectField(request.payload_json, "payload_json"),
        );
      });
    },
    GetNotificationSettings: async (call, callback: UnaryCallback) => {
      await respond(callback, () => {
        const request = call.request ?? {};
        return notifications.getNotificationSettings(contextFromRequest(request));
      });
    },
    Health: async (_call, callback: UnaryCallback) => {
      await respond(callback, () => ({
        contract: "C10",
        mode: "grpc",
        service: "notification-platform",
        status: "ok",
      }));
    },
    ListNotifications: async (call, callback: UnaryCallback) => {
      await respond(callback, () => {
        const request = call.request ?? {};
        return notifications.listNotifications(contextFromRequest(request), {
          ...(request.category ? { category: request.category } : {}),
          ...(request.cursor ? { cursor: request.cursor } : {}),
          ...(request.limit ? { limit: request.limit } : {}),
          ...(request.status ? { status: request.status } : {}),
        });
      });
    },
    MarkNotificationRead: async (call, callback: UnaryCallback) => {
      await respond(callback, () => {
        const request = call.request ?? {};
        return notifications.markNotificationRead(
          request.notification_id,
          contextFromRequest(request),
        );
      });
    },
    UpdateNotificationSettings: async (call, callback: UnaryCallback) => {
      await respond(callback, () => {
        const request = call.request ?? {};
        const settings = parseJsonArrayField(request.settings_json, "settings_json");
        const context = contextFromRequest(request);
        return notifications.updateNotificationSettings(context, {
          contract: "C10.UpdateNotificationSettingsRequest",
          version: C10_VERSION,
          request_id: request.request_id,
          organization_id: request.organization_id,
          user_id: request.user_id,
          settings,
        });
      });
    },
  });

  return server;
}

function loadNotificationPlatformService(protoPath?: string) {
  const packageDefinition = protoLoader.loadSync(resolveNotificationProtoPath(protoPath), {
    defaults: true,
    enums: String,
    keepCase: true,
    longs: String,
    oneofs: true,
  });
  const descriptor = grpc.loadPackageDefinition(packageDefinition) as {
    bridge?: {
      notification?: { v1?: { NotificationPlatform?: { service?: grpc.ServiceDefinition } } };
    };
  };
  const service = descriptor.bridge?.notification?.v1?.NotificationPlatform?.service;
  if (!service) {
    throw new Error("NotificationPlatform service is missing in C10 gRPC proto descriptor");
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

function contextFromRequest(request: Record<string, unknown>) {
  return {
    organizationId: String(request.organization_id ?? ""),
    requestId: String(request.request_id ?? ""),
    userId: String(request.user_id ?? ""),
  };
}

function parseJsonObjectField(value: unknown, field: string): Record<string, unknown> {
  const parsed = parseJsonField(value, field);
  if (!isRecord(parsed)) {
    throw new Error(`SVC-NOTIF gRPC request has invalid ${field}: field must be a JSON object`);
  }
  return parsed;
}

function parseJsonArrayField(value: unknown, field: string): Array<Record<string, unknown>> {
  const parsed = parseJsonField(value, field);
  if (!Array.isArray(parsed)) {
    throw new Error(`SVC-NOTIF gRPC request has invalid ${field}: field must be a JSON array`);
  }
  return parsed as Array<Record<string, unknown>>;
}

function parseJsonField(value: unknown, field: string): unknown {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`SVC-NOTIF gRPC request requires ${field}`);
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SVC-NOTIF gRPC request has invalid ${field}: ${message}`);
  }
}

function toGrpcError(error: unknown): grpc.ServiceError {
  const serviceError = new Error(
    error instanceof Error ? error.message : "SVC-NOTIF gRPC request failed",
  ) as grpc.ServiceError;
  serviceError.code = grpc.status.INTERNAL;
  return serviceError;
}

function resolveNotificationProtoPath(explicitProtoPath?: string): string {
  const moduleDir = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    explicitProtoPath,
    resolve(process.cwd(), "packages/contracts/proto/notifications/c10.notification.proto"),
    resolve(process.cwd(), "../../packages/contracts/proto/notifications/c10.notification.proto"),
    resolve(moduleDir, "../../../packages/contracts/proto/notifications/c10.notification.proto"),
    resolve(moduleDir, "../../../../packages/contracts/proto/notifications/c10.notification.proto"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const protoPath = candidates.find((candidate) => existsSync(candidate));
  if (!protoPath) {
    throw new Error(`Unable to locate C10 gRPC proto. Checked: ${candidates.join(", ")}`);
  }

  return protoPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
