import { existsSync } from "node:fs";
import { resolve } from "node:path";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { OnModuleDestroy } from "@nestjs/common";

import { PgDatabase } from "../../common/database/database.service";
import type { Queryable } from "../../common/database/database.service";
import { collectWorkflowSubSchemaSlugs } from "../workflow/workflow-schema.validator";
import type {
  FbpStartWorkflowFacadeRequest,
  FbpStartWorkflowFacadeResponse,
  FbpTestDraftFacadeRequest,
  FbpTestDraftFacadeResponse,
} from "./fbp-integration.facade";
import type { FbpUpstreamClient } from "./fbp-integration.upstream";

interface JsonResponse {
  json_payload?: string;
}

interface StartWorkflowInstanceGrpcRequest {
  actor_user_id: string;
  context_json: string;
  contract: "C5.StartWorkflowInstanceRequest";
  input_json: string;
  organization_id: string;
  request_id: string;
  schema_json: string;
  version: "1.0.0";
  workflow_id: string;
  workflow_version_id: string;
}

/** У прогона нет ни `workflow_version_id`, ни `input_json`: версии нет, а входом служит полезная нагрузка события. */
interface TestWorkflowDraftGrpcRequest {
  actor_user_id: string;
  context_json: string;
  contract: "C5.TestWorkflowDraftRequest";
  event_payload_json: string;
  organization_id: string;
  request_id: string;
  schema_json: string;
  start_node_id: string;
  version: "1.0.0";
  workflow_id: string;
}

interface FbpEngineGrpcClient extends grpc.Client {
  StartWorkflowInstance(
    request: StartWorkflowInstanceGrpcRequest,
    callback: (error: grpc.ServiceError | null, response?: JsonResponse) => void,
  ): void;
  TestWorkflowDraft(
    request: TestWorkflowDraftGrpcRequest,
    callback: (error: grpc.ServiceError | null, response?: JsonResponse) => void,
  ): void;
  Health(
    request: Record<string, never>,
    callback: (error: grpc.ServiceError | null, response?: JsonResponse) => void,
  ): void;
}

type FbpEngineGrpcClientConstructor = new (
  address: string,
  credentials: grpc.ChannelCredentials,
) => FbpEngineGrpcClient;

export interface FbpWorkflowStartContext {
  context: Record<string, unknown>;
  schema: Record<string, unknown>;
}

export interface FbpExecutionJournalRow {
  created_at: string;
  data: Record<string, unknown>;
  event: string;
  id: string;
  instance_id: string;
  node_id: null | string;
  organization_id: string;
}

export interface FbpPersistStartResultRecord {
  journal: FbpExecutionJournalRow[];
  request: FbpStartWorkflowFacadeRequest;
  response: FbpStartWorkflowFacadeResponse;
}

export interface FbpWorkflowPersistence {
  loadStartContext(request: FbpStartWorkflowFacadeRequest): Promise<FbpWorkflowStartContext>;
  /** Схема драфта для тест-прогона: источник — workflows.draft_schema, версии ещё нет. */
  loadDraftContext(request: FbpTestDraftFacadeRequest): Promise<FbpWorkflowStartContext>;
  persistStartResult(record: FbpPersistStartResultRecord): Promise<void>;
}

export interface FbpGrpcUpstreamClientOptions {
  deadlineMs?: number;
  persistence: FbpWorkflowPersistence;
  protoPath?: string;
  target: string;
}

interface FbpGrpcStartWorkflowPayload extends FbpStartWorkflowFacadeResponse {
  journal?: unknown;
}

const C5_VERSION = "1.0.0";

/**
 * Дедлайн gRPC для тест-прогона. Держится чуть НИЖЕ таймаута фасада (30 с), чтобы
 * первым сработал он: тогда движок узнаёт об отмене и прекращает работу, а не
 * продолжает жечь вызовы в Backend после того, как ответ уже никому не нужен.
 */
const DRAFT_TEST_DEADLINE_MS = 29_000;

export class FbpGrpcUpstreamClient implements FbpUpstreamClient, OnModuleDestroy {
  private readonly client: FbpEngineGrpcClient;
  private readonly deadlineMs: number;
  private readonly persistence: FbpWorkflowPersistence;

  constructor(options: FbpGrpcUpstreamClientOptions) {
    this.deadlineMs = options.deadlineMs ?? 5_000;
    this.persistence = options.persistence;
    this.client = new (loadFbpEngineGrpcClient(options.protoPath))(
      options.target,
      grpc.credentials.createInsecure(),
    );
  }

  async startWorkflowInstance(
    request: FbpStartWorkflowFacadeRequest,
  ): Promise<FbpStartWorkflowFacadeResponse> {
    const startContext = await this.persistence.loadStartContext(request);
    const payload = await this.call<FbpGrpcStartWorkflowPayload>("StartWorkflowInstance", {
      actor_user_id: request.actor_user_id,
      context_json: JSON.stringify(startContext.context),
      contract: "C5.StartWorkflowInstanceRequest",
      input_json: JSON.stringify(request.input ?? {}),
      organization_id: request.organization_id,
      request_id: request.request_id,
      schema_json: JSON.stringify(startContext.schema),
      version: C5_VERSION,
      workflow_id: request.workflow_id,
      workflow_version_id: request.workflow_version_id,
    });
    const journal = normalizeJournal(payload.journal);
    const response = stripInternalPayload(payload);

    await this.persistence.persistStartResult({
      journal,
      request,
      response,
    });

    return response;
  }

  /**
   * Тест-прогон драфта (дефект D5). Симметрии с `startWorkflowInstance` здесь нет
   * намеренно: ни `persistStartResult`, ни журнала, ни события смены состояния —
   * прогон ничего не сохраняет. Это и позволяет гонять его над недостроенной
   * схемой: журнал исполнения ссылается на `workflow_instances` внешним ключом, а
   * тестового инстанса не существует.
   */
  async testWorkflowDraft(
    request: FbpTestDraftFacadeRequest,
  ): Promise<FbpTestDraftFacadeResponse> {
    const draftContext = await this.persistence.loadDraftContext(request);

    return this.call<FbpTestDraftFacadeResponse>(
      "TestWorkflowDraft",
      {
        actor_user_id: request.actor_user_id,
        context_json: JSON.stringify(draftContext.context),
        contract: "C5.TestWorkflowDraftRequest",
        event_payload_json: JSON.stringify(request.event_payload ?? {}),
        organization_id: request.organization_id,
        request_id: request.request_id,
        schema_json: JSON.stringify(draftContext.schema),
        start_node_id: request.start_node_id,
        version: C5_VERSION,
        workflow_id: request.workflow_id,
      },
      // Прогон идёт по настоящему движку: узел backend-api ходит в HTTP, llm — в
      // модель. Общий дедлайн в 5 с обрубал бы любую осмысленную схему раньше, чем
      // она успеет отработать.
      DRAFT_TEST_DEADLINE_MS,
    );
  }

  async getHealth(): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("Health", {});
  }

  onModuleDestroy(): void {
    this.client.close();
  }

  private call<TResponse>(
    method: "StartWorkflowInstance" | "TestWorkflowDraft" | "Health",
    request:
      | StartWorkflowInstanceGrpcRequest
      | TestWorkflowDraftGrpcRequest
      | Record<string, never>,
    deadlineMs: number = this.deadlineMs,
  ): Promise<TResponse> {
    return new Promise((resolveResponse, reject) => {
      const unary = this.client[method].bind(this.client) as unknown as (
        payload: typeof request,
        metadata: grpc.Metadata,
        options: grpc.CallOptions,
        callback: (error: grpc.ServiceError | null, response?: JsonResponse) => void,
      ) => void;
      const deadline = new Date(Date.now() + deadlineMs);

      unary(request, new grpc.Metadata(), { deadline }, (error, response) => {
        if (error) {
          reject(error);
          return;
        }

        if (!response?.json_payload) {
          reject(new Error(`SVC-FBP gRPC ${method} returned an empty payload`));
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

export class PgFbpWorkflowPersistence implements FbpWorkflowPersistence {
  constructor(private readonly database: PgDatabase) {}

  async loadStartContext(
    request: FbpStartWorkflowFacadeRequest,
  ): Promise<FbpWorkflowStartContext> {
    return this.database.withTenant(request.organization_id, async (client) => {
      const result = await client.query<{
        schema: Record<string, unknown>;
        workflow_id: string;
        workflow_version_id: string;
      }>(
        `
          SELECT
            v.schema,
            v.workflow_id,
            v.id AS workflow_version_id
          FROM workflow_versions v
          JOIN workflows w
            ON w.organization_id = v.organization_id AND w.id = v.workflow_id
          WHERE v.organization_id = $1
            AND v.workflow_id = $2
            AND v.id = $3
          LIMIT 1
        `,
        [request.organization_id, request.workflow_id, request.workflow_version_id],
      );

      if (result.rowCount === 0) {
        throw new Error(
          `Workflow version ${request.workflow_version_id} for workflow ${request.workflow_id} was not found.`,
        );
      }

      const row = result.rows[0];
      const schema = {
        ...row.schema,
        workflow_id: row.workflow_id,
        workflow_version_id: row.workflow_version_id,
      };
      const resolvedSubSchemas = await loadActiveWorkflowSubschemas(
        client,
        request.organization_id,
        schema,
      );
      return {
        context: {
          actor_user_id: request.actor_user_id,
          organization_id: request.organization_id,
          trigger: "manual",
        },
        schema: Object.keys(resolvedSubSchemas).length > 0
          ? { ...schema, __resolved_subschemas: resolvedSubSchemas }
          : schema,
      };
    });
  }

  /**
   * Схема ДРАФТА для тест-прогона (дефект D5).
   *
   * Отличие от `loadStartContext` — источник и то, чего здесь нет. Схема берётся из
   * `workflows.draft_schema`, а не из `workflow_versions`: версии у драфта ещё нет и
   * может не появиться никогда. Ничего не сохраняется: ни инстанса, ни журнала —
   * прогон не оставляет следов в боевых таблицах.
   *
   * `workflow_version_id` в схему не подставляется — его нет, и подсунуть сюда
   * идентификатор рабочей версии значило бы соврать журналу узлов о том, что
   * исполнялось.
   *
   * Субсхемы подставляются те же и тем же способом: тест обязан исполнять то же,
   * что исполнит бой, иначе он не тест.
   */
  async loadDraftContext(
    request: FbpTestDraftFacadeRequest,
  ): Promise<FbpWorkflowStartContext> {
    return this.database.withTenant(request.organization_id, async (client) => {
      const result = await client.query<{ draft_schema: Record<string, unknown> | null }>(
        `
          SELECT draft_schema
          FROM workflows
          WHERE organization_id = $1 AND id = $2
          LIMIT 1
        `,
        [request.organization_id, request.workflow_id],
      );

      if (result.rowCount === 0) {
        throw new Error(`Workflow ${request.workflow_id} was not found.`);
      }

      const draftSchema = result.rows[0].draft_schema;
      if (draftSchema === null || typeof draftSchema !== "object") {
        throw new Error(`Workflow ${request.workflow_id} has no draft schema to test.`);
      }

      const schema = { ...draftSchema, workflow_id: request.workflow_id };
      const resolvedSubSchemas = await loadActiveWorkflowSubschemas(
        client,
        request.organization_id,
        schema,
      );

      return {
        context: {
          actor_user_id: request.actor_user_id,
          organization_id: request.organization_id,
          trigger: "draft_test",
        },
        schema:
          Object.keys(resolvedSubSchemas).length > 0
            ? { ...schema, __resolved_subschemas: resolvedSubSchemas }
            : schema,
      };
    });
  }

  async persistStartResult(record: FbpPersistStartResultRecord): Promise<void> {
    const { journal, request, response } = record;
    await this.database.withTenant(request.organization_id, async (client) => {
      await upsertWorkflowInstance(client, request, response, journal);
      await upsertWorkflowState(client, request.organization_id, response);
      await appendWorkflowJournal(client, journal);
    });
  }
}

async function loadActiveWorkflowSubschemas(
  client: Queryable,
  organizationId: string,
  rootSchema: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const resolved: Record<string, unknown> = {};
  const visited = new Set<string>();
  const pending = collectWorkflowSubSchemaSlugs(rootSchema);

  while (pending.length > 0) {
    const slug = pending.shift() as string;
    if (visited.has(slug)) {
      continue;
    }
    visited.add(slug);

    const result = await client.query<{ schema: Record<string, unknown>; slug: string }>(
      `
        SELECT slug, schema
        FROM workflow_subschemas
        WHERE organization_id = $1
          AND status = 'active'
          AND slug = $2
        LIMIT 1
      `,
      [organizationId, slug],
    );
    if (result.rowCount === 0) {
      throw new Error(`Active Workflow subschema ${slug} was not found.`);
    }

    const schema = result.rows[0].schema;
    resolved[slug] = schema;
    for (const nestedSlug of collectWorkflowSubSchemaSlugs(schema)) {
      if (!visited.has(nestedSlug)) {
        pending.push(nestedSlug);
      }
    }
  }

  return resolved;
}

export function createFbpGrpcUpstreamClientFromEnv(
  database: PgDatabase,
  env: NodeJS.ProcessEnv = process.env,
): FbpUpstreamClient | null {
  const target = env.FBP_GRPC_TARGET?.trim();
  if (!target) {
    return null;
  }

  return new FbpGrpcUpstreamClient({
    persistence: new PgFbpWorkflowPersistence(database),
    protoPath: env.FBP_GRPC_PROTO_PATH,
    target,
  });
}

function loadFbpEngineGrpcClient(
  explicitProtoPath?: string,
): FbpEngineGrpcClientConstructor {
  const packageDefinition = protoLoader.loadSync(resolveFbpProtoPath(explicitProtoPath), {
    defaults: true,
    enums: String,
    keepCase: true,
    longs: String,
    oneofs: true,
  });
  const descriptor = grpc.loadPackageDefinition(packageDefinition) as {
    bridge?: { fbp?: { v1?: { FbpEngine?: FbpEngineGrpcClientConstructor } } };
  };
  const clientConstructor = descriptor.bridge?.fbp?.v1?.FbpEngine;
  if (!clientConstructor) {
    throw new Error("FbpEngine service is missing in C5 gRPC proto descriptor");
  }

  return clientConstructor;
}

function resolveFbpProtoPath(explicitProtoPath?: string): string {
  const candidates = [
    explicitProtoPath,
    resolve(process.cwd(), "packages/contracts/proto/fbp/c5.fbp.proto"),
    resolve(process.cwd(), "../../packages/contracts/proto/fbp/c5.fbp.proto"),
    resolve(__dirname, "../../../../../packages/contracts/proto/fbp/c5.fbp.proto"),
    resolve(__dirname, "../../../../../../packages/contracts/proto/fbp/c5.fbp.proto"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const protoPath = candidates.find((candidate) => existsSync(candidate));
  if (!protoPath) {
    throw new Error(`Unable to locate C5 gRPC proto. Checked: ${candidates.join(", ")}`);
  }

  return protoPath;
}

function stripInternalPayload(
  payload: FbpGrpcStartWorkflowPayload,
): FbpStartWorkflowFacadeResponse {
  const { journal: _journal, ...response } = payload;
  return response;
}

function normalizeJournal(value: unknown): FbpExecutionJournalRow[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isJournalRow).map((row) => ({
    created_at: row.created_at,
    data: row.data,
    event: row.event,
    id: row.id,
    instance_id: row.instance_id,
    node_id: row.node_id,
    organization_id: row.organization_id,
  }));
}

function isJournalRow(value: unknown): value is FbpExecutionJournalRow {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.organization_id === "string" &&
    typeof value.instance_id === "string" &&
    (value.node_id === null || typeof value.node_id === "string") &&
    typeof value.event === "string" &&
    isRecord(value.data) &&
    typeof value.created_at === "string"
  );
}

async function upsertWorkflowInstance(
  client: Queryable,
  request: FbpStartWorkflowFacadeRequest,
  response: FbpStartWorkflowFacadeResponse,
  journal: FbpExecutionJournalRow[],
): Promise<void> {
  const startedAt = journal[0]?.created_at ?? response.created_at;
  const finishedAt = isTerminalStatus(response.status)
    ? journal.at(-1)?.created_at ?? response.created_at
    : null;

  await client.query(
    `
      INSERT INTO workflow_instances (
        id,
        organization_id,
        workflow_id,
        version_id,
        status,
        started_at,
        finished_at,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $6::timestamptz)
      ON CONFLICT (id)
      DO UPDATE SET
        status = EXCLUDED.status,
        finished_at = EXCLUDED.finished_at
    `,
    [
      response.instance_id,
      request.organization_id,
      request.workflow_id,
      request.workflow_version_id,
      toDbWorkflowStatus(response.status),
      startedAt,
      finishedAt,
    ],
  );
}

async function upsertWorkflowState(
  client: Queryable,
  organizationId: string,
  response: FbpStartWorkflowFacadeResponse,
): Promise<void> {
  await client.query(
    `
      INSERT INTO workflow_instance_state (instance_id, organization_id, state, updated_at)
      VALUES ($1, $2, $3::jsonb, $4::timestamptz)
      ON CONFLICT (instance_id)
      DO UPDATE SET
        state = EXCLUDED.state,
        updated_at = EXCLUDED.updated_at
    `,
    [
      response.instance_id,
      organizationId,
      JSON.stringify(response.state ?? {}),
      response.created_at,
    ],
  );
}

async function appendWorkflowJournal(
  client: Queryable,
  journal: FbpExecutionJournalRow[],
): Promise<void> {
  for (const row of journal) {
    await client.query(
      `
        INSERT INTO workflow_execution_logs (
          id,
          organization_id,
          instance_id,
          node_id,
          event,
          data,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
        ON CONFLICT (id) DO NOTHING
      `,
      [
        row.id,
        row.organization_id,
        row.instance_id,
        row.node_id,
        row.event,
        JSON.stringify(row.data ?? {}),
        row.created_at,
      ],
    );
  }
}

function toDbWorkflowStatus(status: FbpStartWorkflowFacadeResponse["status"]): string {
  if (status === "completed" || status === "failed" || status === "cancelled") {
    return status;
  }

  return "running";
}

function isTerminalStatus(status: FbpStartWorkflowFacadeResponse["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
