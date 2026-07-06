import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

import { startFbpEngineGrpcServer } from "../../services/fbp-engine/src/grpc-server.js";

const fixedNow = () => "2026-07-06T00:30:00.000Z";

const workflowSchema = {
  schema_version: "1.0.0",
  workflow_id: "workflow-stage-2",
  workflow_version_id: "workflow-version-stage-2",
  entry: "prepare",
  nodes: [
    {
      id: "prepare",
      type: "transform",
      input: {
        amount: { kind: "params", path: ["amount"] },
        title: { kind: "params", path: ["title"] },
      },
      config: {
        expression: {
          op: "merge",
          args: [{ op: "input" }, { op: "lit", value: { executed_by: "real-fbp-engine" } }],
        },
      },
    },
  ],
  connections: [],
};

class RecordingFbpPersistence {
  readonly persisted: any[] = [];

  async loadStartContext(request: any) {
    return {
      context: {
        actor_user_id: request.actor_user_id,
        organization_id: request.organization_id,
        trigger: "manual",
      },
      schema: workflowSchema,
    };
  }

  async persistStartResult(record: any) {
    this.persisted.push(record);
  }
}

interface JsonResponse {
  json_payload?: string;
}

interface FbpEngineGrpcClient extends grpc.Client {
  StartWorkflowInstance(
    request: Record<string, unknown>,
    callback: (error: grpc.ServiceError | null, response?: JsonResponse) => void,
  ): void;
}

describe("Stage 2 MP-02/MP-08 Backend to SVC-FBP gRPC engine", () => {
  it("starts a workflow over gRPC, executes the real engine and persists its journal boundary", async () => {
    const handle = await startFbpEngineGrpcServer({
      backendClient: {
        call: async () => ({ body: {}, headers: {}, status_code: 200 }),
      },
      host: "127.0.0.1",
      now: fixedNow,
      port: 0,
    });
    const persistence = new RecordingFbpPersistence();
    const client = createFbpGrpcClient(`127.0.0.1:${handle.port}`);

    try {
      const request = {
        actor_user_id: "manager-stage-2",
        input: { amount: 500, title: "Order" },
        organization_id: "org-stage-2",
        request_id: "req-stage-2",
        workflow_id: "workflow-stage-2",
        workflow_version_id: "workflow-version-stage-2",
      };
      const startContext = await persistence.loadStartContext(request);
      const payload: any = await callStartWorkflow(client, {
        actor_user_id: request.actor_user_id,
        context_json: JSON.stringify(startContext.context),
        contract: "C5.StartWorkflowInstanceRequest",
        input_json: JSON.stringify(request.input),
        organization_id: request.organization_id,
        request_id: request.request_id,
        schema_json: JSON.stringify(startContext.schema),
        version: "1.0.0",
        workflow_id: request.workflow_id,
        workflow_version_id: request.workflow_version_id,
      });
      const { journal, ...response } = payload;
      await persistence.persistStartResult({ journal, request, response });

      assert.equal(response.contract, "C5.StartWorkflowInstanceResponse");
      assert.equal(response.request_id, "req-stage-2");
      assert.equal(response.organization_id, "org-stage-2");
      assert.equal(response.status, "completed");
      assert.equal(response.degraded, false);
      assert.deepEqual(response.state.output, {
        amount: 500,
        executed_by: "real-fbp-engine",
        title: "Order",
      });
      assert.equal((response.state.backend_api_callback as any)?.mode, undefined);

      assert.equal(persistence.persisted.length, 1);
      assert.equal(persistence.persisted[0].response.instance_id, response.instance_id);
      assert.deepEqual(
        persistence.persisted[0].journal.map((row: any) => row.event),
        ["workflow.started", "node.started", "node.completed", "workflow.completed"],
      );
    } finally {
      client.close();
      await new Promise<void>((resolveShutdown) => {
        handle.server.tryShutdown(() => resolveShutdown());
      });
    }
  });
});

function createFbpGrpcClient(target: string): FbpEngineGrpcClient {
  return new (loadFbpEngineGrpcClient())(target, grpc.credentials.createInsecure());
}

function callStartWorkflow(
  client: FbpEngineGrpcClient,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolveResponse, reject) => {
    client.StartWorkflowInstance(request, (error, response) => {
      if (error) {
        reject(error);
        return;
      }
      if (!response?.json_payload) {
        reject(new Error("SVC-FBP gRPC returned an empty payload"));
        return;
      }
      resolveResponse(JSON.parse(response.json_payload));
    });
  });
}

function loadFbpEngineGrpcClient() {
  const packageDefinition = protoLoader.loadSync(resolveFbpProtoPath(), {
    defaults: true,
    enums: String,
    keepCase: true,
    longs: String,
    oneofs: true,
  });
  const descriptor = grpc.loadPackageDefinition(packageDefinition) as {
    bridge?: { fbp?: { v1?: { FbpEngine?: new (
      address: string,
      credentials: grpc.ChannelCredentials,
    ) => FbpEngineGrpcClient } } };
  };
  const client = descriptor.bridge?.fbp?.v1?.FbpEngine;
  if (!client) {
    throw new Error("FbpEngine service is missing in C5 gRPC proto descriptor");
  }
  return client;
}

function resolveFbpProtoPath(): string {
  const candidates = [
    resolve(process.cwd(), "packages/contracts/proto/fbp/c5.fbp.proto"),
    resolve(process.cwd(), "../../packages/contracts/proto/fbp/c5.fbp.proto"),
  ];
  const protoPath = candidates.find((candidate) => existsSync(candidate));
  if (!protoPath) {
    throw new Error(`Unable to locate C5 gRPC proto. Checked: ${candidates.join(", ")}`);
  }
  return protoPath;
}
