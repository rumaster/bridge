import { C4_VERSION } from "./c4.mjs";
import { C5_VERSION } from "./c5.mjs";
import { C6_VERSION } from "./c6.mjs";
import { C7_VERSION } from "./c7.mjs";
import { C8_VERSION } from "./c8.mjs";
import { C9_VERSION } from "./c9.mjs";
import { C10_VERSION } from "./c10.mjs";
import {
  MESSAGE_MODEL_CONTRACT_ID,
  MESSAGE_MODEL_VERSION,
} from "../message-model/index.mjs";
import { MOBILE_API_VERSION } from "./mobile.mjs";

export const M0_GATE_REQUIRED_CONTRACT_IDS = Object.freeze([
  "C1",
  "C2",
  "C3.auth",
  "C3.base",
  "C4",
  "C5",
  "C6",
  "C7",
  "C8",
  "C9",
  "C10",
  "MOBILE.v1",
]);

export const M0_CONTRACT_REGISTRY = Object.freeze([
  freezeContract({
    id: MESSAGE_MODEL_CONTRACT_ID,
    name: "Canonical Message Model",
    owner: "SVC-CORE",
    stage: "M0",
    version: MESSAGE_MODEL_VERSION,
    artifacts: [
      "packages/contracts/message-model/message.schema.json",
      "packages/contracts/message-model/status-machine.v1.json",
      "packages/contracts/message-model/index.mjs",
    ],
    dtoNames: ["C1.CanonicalMessage"],
  }),
  freezeContract({
    id: "C2",
    name: "Ingress/Egress",
    owner: "SVC-CORE",
    stage: "M0",
    version: "1.0.0",
    artifacts: [
      "packages/contracts/openapi/communication-core-c2.openapi.json",
      "packages/contracts/openapi/c2-internal-api.yaml",
      "packages/contracts/json-schema/c2-ingress-message.schema.json",
      "packages/contracts/json-schema/c2-egress-delivery.schema.json",
    ],
    dtoNames: [
      "C2.IngressMessageRequest",
      "C2.IngressAcceptedResponse",
      "C2.EgressHandoffRequest",
      "C2.EgressHandoffResponse",
      "C2.IngressMessage",
      "C2.EgressDelivery",
    ],
  }),
  freezeContract({
    id: "C3.auth",
    name: "Backend Auth API",
    owner: "SVC-IDN",
    stage: "M0",
    version: "1.0.0",
    basePath: "/api/v1",
    artifacts: ["packages/contracts/openapi/auth/c3.auth.openapi.json"],
    dtoNames: [
      "C3.auth.TelegramLoginStartRequest",
      "C3.auth.TelegramLoginVerifyRequest",
      "C3.auth.AuthSessionResponse",
    ],
  }),
  freezeContract({
    id: "C3.base",
    name: "Backend REST Base",
    owner: "SVC-API",
    stage: "M0",
    version: "1.0.0",
    basePath: "/api/v1",
    artifacts: [
      "packages/contracts/openapi/backend-core/openapi.json",
      "services/backend/src/common/api-error.dto.ts",
      "services/backend/src/common/query/pagination-query.dto.ts",
    ],
    dtoNames: [
      "C3.base.ApiErrorResponse",
      "C3.base.PaginationQuery",
      "C3.base.HealthResponse",
    ],
  }),
  freezeContract({
    id: "C4",
    name: "AI Platform",
    owner: "SVC-AI",
    stage: "M0",
    version: C4_VERSION,
    basePath: "/api/v1",
    artifacts: [
      "packages/contracts/openapi/ai/c4.ai.openapi.json",
      "packages/contracts/json-schema/c4-ai-onboarding-command.schema.json",
      "packages/contracts/src/c4.mjs",
    ],
    dtoNames: [
      "C4.AssistantSuggestRequest",
      "C4.AssistantSuggestResponse",
      "C4.OnboardingCommandRequest",
      "C4.OnboardingCommandResponse",
      "C4.AiOnboardingCommand",
    ],
  }),
  freezeContract({
    id: "C5",
    name: "FBP Engine",
    owner: "SVC-FBP",
    stage: "M0",
    version: C5_VERSION,
    basePath: "/api/v1",
    artifacts: [
      "packages/contracts/openapi/fbp/c5.fbp.openapi.json",
      "packages/contracts/events/workflow-state-changed.schema.json",
      "packages/contracts/src/c5.mjs",
    ],
    dtoNames: [
      "C5.StartWorkflowInstanceRequest",
      "C5.StartWorkflowInstanceResponse",
      "C5.BackendApiNodeCallbackRequest",
      "C5.BackendApiNodeCallbackResponse",
      "C7.WorkflowStateChangedEvent",
    ],
  }),
  freezeContract({
    id: "C6",
    name: "Capability Descriptor",
    owner: "SVC-INT",
    stage: "M0",
    version: C6_VERSION,
    artifacts: [
      "packages/contracts/json-schema/c6-capability-descriptor.schema.json",
      "packages/contracts/src/c6.mjs",
    ],
    dtoNames: ["C6.CapabilityDescriptor"],
  }),
  freezeContract({
    id: "C7",
    name: "WebSocket Events",
    owner: "SVC-CORE/SVC-API",
    stage: "M0",
    version: C7_VERSION,
    basePath: "/api/v1",
    artifacts: [
      "packages/contracts/openapi/edge/c7.websocket.openapi.json",
      "packages/contracts/events/c7-websocket-event.schema.json",
      "packages/contracts/src/c7.mjs",
    ],
    dtoNames: ["C7.WebSocketEvent"],
  }),
  freezeContract({
    id: "C8",
    name: "Broadcast Platform",
    owner: "SVC-BCAST",
    stage: "M0",
    version: C8_VERSION,
    basePath: "/api/v1",
    artifacts: [
      "packages/contracts/openapi/broadcasts/c8.broadcasts.openapi.json",
      "packages/contracts/json-schema/c8-core-delivery-draft.schema.json",
      "packages/contracts/src/c8.mjs",
    ],
    dtoNames: [
      "C8.CreateBroadcastRequest",
      "C8.CreateBroadcastResponse",
      "C8.StartBroadcastRequest",
      "C8.StartBroadcastResponse",
      "C8.BroadcastStatsResponse",
      "C8.BroadcastCoreDeliveryDraft",
    ],
  }),
  freezeContract({
    id: "C9",
    name: "Edge/App Tunnel",
    owner: "SVC-EDGE",
    stage: "M0",
    version: C9_VERSION,
    basePath: "/api/v1",
    artifacts: [
      "packages/contracts/openapi/edge/c9.edge-tunnel.openapi.json",
      "packages/contracts/json-schema/c9-edge-tunnel-message.schema.json",
      "packages/contracts/json-schema/c9-edge-tunnel-ack.schema.json",
      "packages/contracts/src/c9.mjs",
    ],
    dtoNames: ["C9.EdgeTunnelMessage", "C9.EdgeTunnelAck"],
  }),
  freezeContract({
    id: "C10",
    name: "Notification Platform",
    owner: "SVC-NOTIF",
    stage: "M0",
    version: C10_VERSION,
    basePath: "/api/v1",
    artifacts: [
      "packages/contracts/openapi/notifications/c10.notifications.openapi.json",
      "packages/contracts/events/notification-created.schema.json",
      "packages/contracts/events/notification-trigger.schema.json",
      "packages/contracts/src/c10.mjs",
    ],
    dtoNames: [
      "C10.Notification",
      "C10.NotificationSettings",
      "C10.NotificationTriggerEvent",
      "C7.NotificationCreatedEvent",
    ],
  }),
  freezeContract({
    id: "MOBILE.v1",
    name: "Mobile API",
    owner: "SVC-MOB",
    stage: "M0",
    version: MOBILE_API_VERSION,
    basePath: "/mobile/v1",
    artifacts: [
      "packages/contracts/openapi/mobile/mobile.v1.openapi.json",
      "packages/contracts/mobile/consumer-contracts.v1.json",
      "packages/contracts/src/mobile.mjs",
    ],
    dtoNames: [
      "MOBILE.AuthSessionResponse",
      "MOBILE.DialogListResponse",
      "MOBILE.SendMessageRequest",
      "MOBILE.SendMessageResponse",
      "MOBILE.SyncResponse",
      "MOBILE.DeviceRegistrationRequest",
      "MOBILE.DeviceRegistrationResponse",
      "MOBILE.PushPayloadStub",
    ],
  }),
]);

export function getM0ContractRegistry() {
  return M0_CONTRACT_REGISTRY.map((contract) => ({
    ...contract,
    artifacts: [...contract.artifacts],
    dtoNames: [...contract.dtoNames],
  }));
}

export function findM0Contract(contractId) {
  return M0_CONTRACT_REGISTRY.find((contract) => contract.id === contractId);
}

export function validateM0ContractRegistry(
  registry = M0_CONTRACT_REGISTRY,
  requiredIds = M0_GATE_REQUIRED_CONTRACT_IDS,
) {
  const errors = [];

  assertUnique(errors, registry.map((contract) => contract.id), "contract id");
  assertUnique(
    errors,
    registry.flatMap((contract) => contract.dtoNames),
    "DTO name",
  );
  assertUnique(
    errors,
    registry.flatMap((contract) => contract.artifacts),
    "artifact path",
  );

  for (const requiredId of requiredIds) {
    if (!registry.some((contract) => contract.id === requiredId)) {
      errors.push(`required contract ${requiredId} is missing from M0 registry`);
    }
  }

  for (const contract of registry) {
    if (!isSemver(contract.version)) {
      errors.push(`${contract.id} version must be semver, got ${contract.version}`);
    }

    for (const field of ["id", "name", "owner", "stage"]) {
      if (typeof contract[field] !== "string" || contract[field].trim() === "") {
        errors.push(`${contract.id || "contract"} ${field} must be a non-empty string`);
      }
    }

    if (!Array.isArray(contract.artifacts) || contract.artifacts.length === 0) {
      errors.push(`${contract.id} must publish at least one artifact`);
    }

    if (!Array.isArray(contract.dtoNames) || contract.dtoNames.length === 0) {
      errors.push(`${contract.id} must publish at least one DTO name`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function freezeContract(contract) {
  return Object.freeze({
    ...contract,
    artifacts: Object.freeze([...contract.artifacts]),
    dtoNames: Object.freeze([...contract.dtoNames]),
  });
}

function assertUnique(errors, values, label) {
  const seen = new Set();

  for (const value of values) {
    if (seen.has(value)) {
      errors.push(`duplicate ${label}: ${value}`);
    }
    seen.add(value);
  }
}

function isSemver(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
}
