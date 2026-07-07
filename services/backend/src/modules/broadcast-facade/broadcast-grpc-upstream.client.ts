import { existsSync } from "node:fs";
import { resolve } from "node:path";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { OnModuleDestroy } from "@nestjs/common";

interface JsonResponse {
  json_payload?: string;
}

interface BroadcastListFacadeRequest {
  organization_id: string;
  request_id: string;
}

interface BroadcastCreateFacadeRequest extends BroadcastListFacadeRequest {
  created_by: string;
  filter?: Record<string, unknown>;
  name: string;
  rate_limit?: Record<string, unknown>;
  schedule?: Record<string, unknown>;
  template?: Record<string, unknown>;
}

interface BroadcastStartFacadeRequest extends BroadcastListFacadeRequest {
  broadcast_id: string;
  mode?: "immediate" | "scheduled";
  scheduled_for?: string;
  started_by: string;
}

interface BroadcastStatsFacadeRequest extends BroadcastListFacadeRequest {
  broadcast_id: string;
}

type BroadcastListFacadeResponse = any;
type BroadcastCreateFacadeResponse = any;
type BroadcastStartFacadeResponse = any;
type BroadcastStatsFacadeResponse = any;

interface ListBroadcastsGrpcRequest extends BroadcastListFacadeRequest {
  contract: "C8.ListBroadcastsRequest";
  version: "1.0.0";
}

interface CreateBroadcastGrpcRequest {
  contract: "C8.CreateBroadcastRequest";
  version: "1.0.0";
  request_id: string;
  organization_id: string;
  created_by: string;
  name: string;
  template_json: string;
  filter_json: string;
  schedule_json: string;
  rate_limit_json: string;
}

interface StartBroadcastGrpcRequest {
  contract: "C8.StartBroadcastRequest";
  version: "1.0.0";
  request_id: string;
  organization_id: string;
  broadcast_id: string;
  started_by: string;
  mode: "immediate" | "scheduled";
  scheduled_for: string;
  idempotency_key: string;
}

interface BroadcastStatsGrpcRequest extends BroadcastStatsFacadeRequest {
  contract: "C8.BroadcastStatsRequest";
  version: "1.0.0";
}

interface BroadcastPlatformGrpcClient extends grpc.Client {
  ListBroadcasts(
    request: ListBroadcastsGrpcRequest,
    callback: (error: grpc.ServiceError | null, response?: JsonResponse) => void,
  ): void;
  CreateBroadcast(
    request: CreateBroadcastGrpcRequest,
    callback: (error: grpc.ServiceError | null, response?: JsonResponse) => void,
  ): void;
  StartBroadcast(
    request: StartBroadcastGrpcRequest,
    callback: (error: grpc.ServiceError | null, response?: JsonResponse) => void,
  ): void;
  GetBroadcastStats(
    request: BroadcastStatsGrpcRequest,
    callback: (error: grpc.ServiceError | null, response?: JsonResponse) => void,
  ): void;
  Health(
    request: Record<string, never>,
    callback: (error: grpc.ServiceError | null, response?: JsonResponse) => void,
  ): void;
}

type BroadcastPlatformGrpcClientConstructor = new (
  address: string,
  credentials: grpc.ChannelCredentials,
) => BroadcastPlatformGrpcClient;

export interface BroadcastGrpcUpstreamClientOptions {
  deadlineMs?: number;
  protoPath?: string;
  target: string;
}

export class BroadcastGrpcUpstreamClient implements OnModuleDestroy {
  private readonly client: BroadcastPlatformGrpcClient;
  private readonly deadlineMs: number;

  constructor(options: BroadcastGrpcUpstreamClientOptions) {
    this.deadlineMs = options.deadlineMs ?? 5_000;
    this.client = new (loadBroadcastPlatformGrpcClient(options.protoPath))(
      options.target,
      grpc.credentials.createInsecure(),
    );
  }

  listBroadcasts(
    request: BroadcastListFacadeRequest,
  ): Promise<BroadcastListFacadeResponse> {
    return this.call<BroadcastListFacadeResponse>("ListBroadcasts", {
      ...request,
      contract: "C8.ListBroadcastsRequest",
      version: "1.0.0",
    });
  }

  createBroadcast(
    request: BroadcastCreateFacadeRequest,
  ): Promise<BroadcastCreateFacadeResponse> {
    return this.call<BroadcastCreateFacadeResponse>("CreateBroadcast", {
      contract: "C8.CreateBroadcastRequest",
      version: "1.0.0",
      request_id: request.request_id,
      organization_id: request.organization_id,
      created_by: request.created_by,
      name: request.name,
      template_json: JSON.stringify(request.template ?? {}),
      filter_json: JSON.stringify(request.filter ?? {}),
      schedule_json: JSON.stringify(request.schedule ?? {}),
      rate_limit_json: JSON.stringify(request.rate_limit ?? {}),
    });
  }

  startBroadcast(
    request: BroadcastStartFacadeRequest,
  ): Promise<BroadcastStartFacadeResponse> {
    return this.call<BroadcastStartFacadeResponse>("StartBroadcast", {
      contract: "C8.StartBroadcastRequest",
      version: "1.0.0",
      request_id: request.request_id,
      organization_id: request.organization_id,
      broadcast_id: request.broadcast_id,
      started_by: request.started_by,
      mode: request.mode ?? "immediate",
      scheduled_for: request.scheduled_for ?? "",
      idempotency_key: request.request_id,
    });
  }

  getBroadcastStats(
    request: BroadcastStatsFacadeRequest,
  ): Promise<BroadcastStatsFacadeResponse> {
    return this.call<BroadcastStatsFacadeResponse>("GetBroadcastStats", {
      ...request,
      contract: "C8.BroadcastStatsRequest",
      version: "1.0.0",
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
      | "ListBroadcasts"
      | "CreateBroadcast"
      | "StartBroadcast"
      | "GetBroadcastStats"
      | "Health",
    request:
      | ListBroadcastsGrpcRequest
      | CreateBroadcastGrpcRequest
      | StartBroadcastGrpcRequest
      | BroadcastStatsGrpcRequest
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
          reject(new Error(`SVC-BCAST gRPC ${method} returned an empty payload`));
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

export function createBroadcastGrpcUpstreamClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BroadcastGrpcUpstreamClient | null {
  const target = env.BROADCAST_GRPC_TARGET?.trim();
  if (!target) {
    return null;
  }

  return new BroadcastGrpcUpstreamClient({
    protoPath: env.BROADCAST_GRPC_PROTO_PATH,
    target,
  });
}

function loadBroadcastPlatformGrpcClient(
  explicitProtoPath?: string,
): BroadcastPlatformGrpcClientConstructor {
  const packageDefinition = protoLoader.loadSync(resolveBroadcastProtoPath(explicitProtoPath), {
    defaults: true,
    enums: String,
    keepCase: true,
    longs: String,
    oneofs: true,
  });
  const descriptor = grpc.loadPackageDefinition(packageDefinition) as {
    bridge?: {
      broadcast?: { v1?: { BroadcastPlatform?: BroadcastPlatformGrpcClientConstructor } };
    };
  };
  const clientConstructor = descriptor.bridge?.broadcast?.v1?.BroadcastPlatform;
  if (!clientConstructor) {
    throw new Error("BroadcastPlatform service is missing in C8 gRPC proto descriptor");
  }

  return clientConstructor;
}

function resolveBroadcastProtoPath(explicitProtoPath?: string): string {
  const candidates = [
    explicitProtoPath,
    resolve(process.cwd(), "packages/contracts/proto/broadcasts/c8.broadcast.proto"),
    resolve(process.cwd(), "../../packages/contracts/proto/broadcasts/c8.broadcast.proto"),
    resolve(__dirname, "../../../../../packages/contracts/proto/broadcasts/c8.broadcast.proto"),
    resolve(__dirname, "../../../../../../packages/contracts/proto/broadcasts/c8.broadcast.proto"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const protoPath = candidates.find((candidate) => existsSync(candidate));
  if (!protoPath) {
    throw new Error(`Unable to locate C8 gRPC proto. Checked: ${candidates.join(", ")}`);
  }

  return protoPath;
}
