import { existsSync } from "node:fs";
import { resolve } from "node:path";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { OnModuleDestroy } from "@nestjs/common";

interface JsonResponse {
  json_payload?: string;
}

interface NotificationListFacadeRequest {
  category?: string;
  cursor?: string;
  limit?: number;
  organization_id: string;
  request_id: string;
  status?: string;
  user_id: string;
}

interface NotificationReadFacadeRequest {
  notification_id: string;
  organization_id: string;
  request_id: string;
  user_id: string;
}

interface NotificationSettingsFacadeRequest {
  organization_id: string;
  request_id: string;
  user_id: string;
}

interface NotificationSettingsUpdateFacadeRequest
  extends NotificationSettingsFacadeRequest {
  settings: Array<Record<string, unknown>>;
}

type NotificationListFacadeResponse = any;
type NotificationReadFacadeResponse = any;
type NotificationSettingsFacadeResponse = any;

interface ListNotificationsGrpcRequest extends NotificationListFacadeRequest {
  contract: "C10.ListNotificationsRequest";
  version: "1.0.0";
}

interface MarkNotificationReadGrpcRequest extends NotificationReadFacadeRequest {
  contract: "C10.MarkNotificationReadRequest";
  version: "1.0.0";
}

interface NotificationSettingsGrpcRequest extends NotificationSettingsFacadeRequest {
  contract: "C10.NotificationSettingsRequest";
  version: "1.0.0";
}

interface UpdateNotificationSettingsGrpcRequest extends NotificationSettingsFacadeRequest {
  contract: "C10.UpdateNotificationSettingsRequest";
  version: "1.0.0";
  settings_json: string;
}

interface NotificationPlatformGrpcClient extends grpc.Client {
  ListNotifications(
    request: ListNotificationsGrpcRequest,
    callback: (error: grpc.ServiceError | null, response?: JsonResponse) => void,
  ): void;
  MarkNotificationRead(
    request: MarkNotificationReadGrpcRequest,
    callback: (error: grpc.ServiceError | null, response?: JsonResponse) => void,
  ): void;
  GetNotificationSettings(
    request: NotificationSettingsGrpcRequest,
    callback: (error: grpc.ServiceError | null, response?: JsonResponse) => void,
  ): void;
  UpdateNotificationSettings(
    request: UpdateNotificationSettingsGrpcRequest,
    callback: (error: grpc.ServiceError | null, response?: JsonResponse) => void,
  ): void;
  Health(
    request: Record<string, never>,
    callback: (error: grpc.ServiceError | null, response?: JsonResponse) => void,
  ): void;
}

type NotificationPlatformGrpcClientConstructor = new (
  address: string,
  credentials: grpc.ChannelCredentials,
) => NotificationPlatformGrpcClient;

export interface NotificationGrpcUpstreamClientOptions {
  deadlineMs?: number;
  protoPath?: string;
  target: string;
}

export class NotificationGrpcUpstreamClient implements OnModuleDestroy {
  private readonly client: NotificationPlatformGrpcClient;
  private readonly deadlineMs: number;

  constructor(options: NotificationGrpcUpstreamClientOptions) {
    this.deadlineMs = options.deadlineMs ?? 5_000;
    this.client = new (loadNotificationPlatformGrpcClient(options.protoPath))(
      options.target,
      grpc.credentials.createInsecure(),
    );
  }

  listNotifications(
    request: NotificationListFacadeRequest,
  ): Promise<NotificationListFacadeResponse> {
    return this.call<NotificationListFacadeResponse>("ListNotifications", {
      ...request,
      contract: "C10.ListNotificationsRequest",
      version: "1.0.0",
    });
  }

  markNotificationRead(
    request: NotificationReadFacadeRequest,
  ): Promise<NotificationReadFacadeResponse> {
    return this.call<NotificationReadFacadeResponse>("MarkNotificationRead", {
      ...request,
      contract: "C10.MarkNotificationReadRequest",
      version: "1.0.0",
    });
  }

  getNotificationSettings(
    request: NotificationSettingsFacadeRequest,
  ): Promise<NotificationSettingsFacadeResponse> {
    return this.call<NotificationSettingsFacadeResponse>("GetNotificationSettings", {
      ...request,
      contract: "C10.NotificationSettingsRequest",
      version: "1.0.0",
    });
  }

  updateNotificationSettings(
    request: NotificationSettingsUpdateFacadeRequest,
  ): Promise<NotificationSettingsFacadeResponse> {
    return this.call<NotificationSettingsFacadeResponse>("UpdateNotificationSettings", {
      contract: "C10.UpdateNotificationSettingsRequest",
      version: "1.0.0",
      request_id: request.request_id,
      organization_id: request.organization_id,
      user_id: request.user_id,
      settings_json: JSON.stringify(request.settings),
    });
  }

  async getHealth(): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("Health", {});
  }

  onModuleDestroy(): void {
    this.client.close();
  }

  private call<TResponse>(
    method:
      | "ListNotifications"
      | "MarkNotificationRead"
      | "GetNotificationSettings"
      | "UpdateNotificationSettings"
      | "Health",
    request:
      | ListNotificationsGrpcRequest
      | MarkNotificationReadGrpcRequest
      | NotificationSettingsGrpcRequest
      | UpdateNotificationSettingsGrpcRequest
      | Record<string, never>,
  ): Promise<TResponse> {
    return new Promise((resolveResponse, reject) => {
      const unary = this.client[method].bind(this.client) as unknown as (
        payload: typeof request,
        metadata: grpc.Metadata,
        options: grpc.CallOptions,
        callback: (error: grpc.ServiceError | null, response?: JsonResponse) => void,
      ) => void;
      const deadline = new Date(Date.now() + this.deadlineMs);

      unary(request, new grpc.Metadata(), { deadline }, (error, response) => {
        if (error) {
          reject(error);
          return;
        }

        if (!response?.json_payload) {
          reject(new Error(`SVC-NOTIF gRPC ${method} returned an empty payload`));
          return;
        }

        try {
          resolveResponse(JSON.parse(response.json_payload) as TResponse);
        } catch (parseError) {
          reject(parseError);
        }
      });
    });
  }
}

export function createNotificationGrpcUpstreamClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): NotificationGrpcUpstreamClient | null {
  const target = env.NOTIFICATION_GRPC_TARGET?.trim();
  if (!target) {
    return null;
  }

  return new NotificationGrpcUpstreamClient({
    protoPath: env.NOTIFICATION_GRPC_PROTO_PATH,
    target,
  });
}

function loadNotificationPlatformGrpcClient(
  explicitProtoPath?: string,
): NotificationPlatformGrpcClientConstructor {
  const packageDefinition = protoLoader.loadSync(resolveNotificationProtoPath(explicitProtoPath), {
    defaults: true,
    enums: String,
    keepCase: true,
    longs: String,
    oneofs: true,
  });
  const descriptor = grpc.loadPackageDefinition(packageDefinition) as {
    bridge?: {
      notification?: {
        v1?: { NotificationPlatform?: NotificationPlatformGrpcClientConstructor };
      };
    };
  };
  const clientConstructor = descriptor.bridge?.notification?.v1?.NotificationPlatform;
  if (!clientConstructor) {
    throw new Error("NotificationPlatform service is missing in C10 gRPC proto descriptor");
  }

  return clientConstructor;
}

function resolveNotificationProtoPath(explicitProtoPath?: string): string {
  const candidates = [
    explicitProtoPath,
    resolve(process.cwd(), "packages/contracts/proto/notifications/c10.notification.proto"),
    resolve(process.cwd(), "../../packages/contracts/proto/notifications/c10.notification.proto"),
    resolve(
      __dirname,
      "../../../../../packages/contracts/proto/notifications/c10.notification.proto",
    ),
    resolve(
      __dirname,
      "../../../../../../packages/contracts/proto/notifications/c10.notification.proto",
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const protoPath = candidates.find((candidate) => existsSync(candidate));
  if (!protoPath) {
    throw new Error(`Unable to locate C10 gRPC proto. Checked: ${candidates.join(", ")}`);
  }

  return protoPath;
}
