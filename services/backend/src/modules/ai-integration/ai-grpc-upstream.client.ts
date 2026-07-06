import { existsSync } from "node:fs";
import { resolve } from "node:path";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { OnModuleDestroy } from "@nestjs/common";

import type {
  AiAssistantFacadeRequest,
  AiAssistantFacadeResponse,
  AiOnboardingFacadeRequest,
  AiOnboardingFacadeResponse,
} from "./ai-integration.types";
import type { AiUpstreamClient } from "./ai-integration.upstream";

interface JsonResponse {
  json_payload?: string;
}

interface AssistantSuggestGrpcRequest extends AiAssistantFacadeRequest {
  contract: "C4.AssistantSuggestRequest";
  version: "1.0.0";
}

interface OnboardingCommandGrpcRequest extends AiOnboardingFacadeRequest {
  actor_user_id: string;
  contract: "C4.OnboardingCommandRequest";
  version: "1.0.0";
}

interface AiPlatformGrpcClient extends grpc.Client {
  SuggestAssistant(
    request: AssistantSuggestGrpcRequest,
    callback: (error: grpc.ServiceError | null, response?: JsonResponse) => void,
  ): void;
  CreateOnboardingCommand(
    request: OnboardingCommandGrpcRequest,
    callback: (error: grpc.ServiceError | null, response?: JsonResponse) => void,
  ): void;
  Health(
    request: Record<string, never>,
    callback: (error: grpc.ServiceError | null, response?: JsonResponse) => void,
  ): void;
}

type AiPlatformGrpcClientConstructor = new (
  address: string,
  credentials: grpc.ChannelCredentials,
) => AiPlatformGrpcClient;

export interface AiGrpcUpstreamClientOptions {
  target: string;
  protoPath?: string;
  deadlineMs?: number;
}

export class AiGrpcUpstreamClient implements AiUpstreamClient, OnModuleDestroy {
  private readonly client: AiPlatformGrpcClient;
  private readonly deadlineMs: number;

  constructor(options: AiGrpcUpstreamClientOptions) {
    this.deadlineMs = options.deadlineMs ?? 5_000;
    this.client = new (loadAiPlatformGrpcClient(options.protoPath))(
      options.target,
      grpc.credentials.createInsecure(),
    );
  }

  suggestAssistant(request: AiAssistantFacadeRequest): Promise<AiAssistantFacadeResponse> {
    return this.call<AiAssistantFacadeResponse>("SuggestAssistant", {
      ...request,
      contract: "C4.AssistantSuggestRequest",
      version: "1.0.0",
    });
  }

  createOnboardingCommand(
    request: AiOnboardingFacadeRequest,
  ): Promise<AiOnboardingFacadeResponse> {
    return this.call<AiOnboardingFacadeResponse>("CreateOnboardingCommand", {
      ...request,
      actor_user_id: "backend-ai-facade",
      contract: "C4.OnboardingCommandRequest",
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
    method: "SuggestAssistant" | "CreateOnboardingCommand" | "Health",
    request:
      | AssistantSuggestGrpcRequest
      | OnboardingCommandGrpcRequest
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
          reject(new Error(`SVC-AI gRPC ${method} returned an empty payload`));
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

export function createAiGrpcUpstreamClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AiUpstreamClient | null {
  const target = env.AI_GRPC_TARGET?.trim();
  if (!target) {
    return null;
  }

  return new AiGrpcUpstreamClient({
    protoPath: env.AI_GRPC_PROTO_PATH,
    target,
  });
}

function loadAiPlatformGrpcClient(
  explicitProtoPath?: string,
): AiPlatformGrpcClientConstructor {
  const packageDefinition = protoLoader.loadSync(resolveAiProtoPath(explicitProtoPath), {
    defaults: true,
    enums: String,
    keepCase: true,
    longs: String,
    oneofs: true,
  });
  const descriptor = grpc.loadPackageDefinition(packageDefinition) as {
    bridge?: { ai?: { v1?: { AiPlatform?: AiPlatformGrpcClientConstructor } } };
  };
  const clientConstructor = descriptor.bridge?.ai?.v1?.AiPlatform;
  if (!clientConstructor) {
    throw new Error("AiPlatform service is missing in C4 gRPC proto descriptor");
  }

  return clientConstructor;
}

function resolveAiProtoPath(explicitProtoPath?: string): string {
  const candidates = [
    explicitProtoPath,
    resolve(process.cwd(), "packages/contracts/proto/ai/c4.ai.proto"),
    resolve(process.cwd(), "../../packages/contracts/proto/ai/c4.ai.proto"),
    resolve(__dirname, "../../../../../packages/contracts/proto/ai/c4.ai.proto"),
    resolve(__dirname, "../../../../../../packages/contracts/proto/ai/c4.ai.proto"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const protoPath = candidates.find((candidate) => existsSync(candidate));
  if (!protoPath) {
    throw new Error(
      `Unable to locate C4 gRPC proto. Checked: ${candidates.join(", ")}`,
    );
  }

  return protoPath;
}
