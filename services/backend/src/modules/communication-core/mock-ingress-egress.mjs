import {
  MESSAGE_DIRECTION,
  MESSAGE_STATUS,
  assertMessageStatusTransition,
  validateCanonicalMessage,
} from "../../../../../packages/contracts/message-model/index.mjs";

export class CommunicationCoreMockValidationError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = "CommunicationCoreMockValidationError";
    this.errors = errors;
  }
}

function assertValidCanonicalMessage(message, context) {
  const result = validateCanonicalMessage(message);

  if (!result.valid) {
    throw new CommunicationCoreMockValidationError(
      `Invalid ${context}: ${result.errors.join("; ")}`,
      result.errors,
    );
  }
}

function assertRequiredString(value, field, errors) {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${field} is required`);
  }
}

function assertEgressTarget(target) {
  const errors = [];

  if (target === null || typeof target !== "object" || Array.isArray(target)) {
    errors.push("adapter target must be an object");
  } else {
    assertRequiredString(target.adapter, "adapter", errors);
    assertRequiredString(target.adapter_endpoint_id, "adapter_endpoint_id", errors);
  }

  if (errors.length > 0) {
    throw new CommunicationCoreMockValidationError(
      `Invalid C2 egress target: ${errors.join("; ")}`,
      errors,
    );
  }
}

function assertIngressState(message) {
  const errors = [];

  if (message.direction !== MESSAGE_DIRECTION.INBOUND) {
    errors.push("direction must be inbound for C2 ingress");
  }

  if (message.status !== MESSAGE_STATUS.RECEIVED) {
    errors.push("status must be received for C2 ingress");
  }

  if (errors.length > 0) {
    throw new CommunicationCoreMockValidationError(
      `Invalid C2 ingress message: ${errors.join("; ")}`,
      errors,
    );
  }
}

function assertEgressState(message) {
  const errors = [];

  if (message.direction !== MESSAGE_DIRECTION.OUTBOUND) {
    errors.push("direction must be outbound for C2 egress");
  }

  if (message.status !== MESSAGE_STATUS.ROUTED) {
    errors.push("status must be routed for C2 egress");
  }

  if (!assertMessageStatusTransition(MESSAGE_STATUS.ROUTED, MESSAGE_STATUS.SENT)) {
    errors.push("status machine must allow routed -> sent for C2 egress");
  }

  if (errors.length > 0) {
    throw new CommunicationCoreMockValidationError(
      `Invalid C2 egress message: ${errors.join("; ")}`,
      errors,
    );
  }
}

export function createCommunicationCoreMock(options = {}) {
  const clock = options.clock ?? (() => new Date().toISOString());
  const ingressResponsesByIdempotencyKey = new Map();
  const egressHandoffs = [];

  return {
    acceptIngressMessage(message) {
      assertValidCanonicalMessage(message, "C2 ingress message");
      assertIngressState(message);

      const existingResponse = ingressResponsesByIdempotencyKey.get(message.idempotency_key);
      if (existingResponse) {
        return {
          ...existingResponse,
          duplicate: true,
        };
      }

      const response = Object.freeze({
        accepted: true,
        mock: true,
        duplicate: false,
        message_id: message.id,
        idempotency_key: message.idempotency_key,
        organization_id: message.organization_id,
        conversation_id: message.conversation_id,
        endpoint_id: message.endpoint_id,
        sequence_number: message.sequence_number,
        status: MESSAGE_STATUS.RECEIVED,
        received_at: clock(),
      });

      ingressResponsesByIdempotencyKey.set(message.idempotency_key, response);
      return response;
    },

    handoffEgressMessage(message, target) {
      assertValidCanonicalMessage(message, "C2 egress message");
      assertEgressState(message);
      assertEgressTarget(target);

      const response = Object.freeze({
        accepted: true,
        mock_delivery: true,
        message_id: message.id,
        idempotency_key: message.idempotency_key,
        organization_id: message.organization_id,
        endpoint_id: message.endpoint_id,
        channel: message.channel,
        sequence_number: message.sequence_number,
        adapter: target.adapter,
        adapter_endpoint_id: target.adapter_endpoint_id,
        delivery_status: MESSAGE_STATUS.SENT,
        sent_at: clock(),
      });

      egressHandoffs.push(response);
      return response;
    },

    getIngressAcceptances() {
      return Array.from(ingressResponsesByIdempotencyKey.values());
    },

    getEgressHandoffs() {
      return [...egressHandoffs];
    },
  };
}
