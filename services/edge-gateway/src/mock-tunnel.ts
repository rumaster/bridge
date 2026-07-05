import {
  createEdgeTunnelAck,
  validateEdgeTunnelMessage,
} from "../../../packages/contracts/src/c9.js";

export class EdgeTunnelMockValidationError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = "EdgeTunnelMockValidationError";
    this.errors = errors;
  }
}

export function createMockEdgeTunnel({
  core,
  now = () => new Date().toISOString(),
} = {}) {
  const acceptedByIdempotencyKey = new Map();
  const metrics = {
    forwarded_total: 0,
    duplicate_total: 0,
    rejected_total: 0,
  };

  return {
    forward(tunnelMessage) {
      const validation = validateEdgeTunnelMessage(tunnelMessage);

      if (!validation.valid) {
        metrics.rejected_total += 1;
        throw new EdgeTunnelMockValidationError(
          `Invalid C9 tunnel message: ${validation.errors.join("; ")}`,
          validation.errors,
        );
      }

      const existingAck = acceptedByIdempotencyKey.get(tunnelMessage.idempotency_key);
      if (existingAck) {
        metrics.duplicate_total += 1;
        return {
          ...existingAck,
          duplicate: true,
          received_at: now(),
        };
      }

      const coreResponse = core?.acceptIngressMessage
        ? core.acceptIngressMessage(tunnelMessage.payload)
        : {
            accepted: true,
            duplicate: false,
            message_id: tunnelMessage.payload.id,
            status: tunnelMessage.payload.status,
          };

      const ack = createEdgeTunnelAck({
        accepted: coreResponse.accepted === true,
        duplicate: coreResponse.duplicate === true,
        messageId: coreResponse.message_id ?? tunnelMessage.payload.id,
        endpointId: tunnelMessage.endpoint_id,
        sequenceNumber: tunnelMessage.sequence_number,
        idempotencyKey: tunnelMessage.idempotency_key,
        coreStatus: coreResponse.status ?? tunnelMessage.payload.status,
        receivedAt: now(),
      });

      acceptedByIdempotencyKey.set(tunnelMessage.idempotency_key, ack);
      metrics.forwarded_total += 1;
      if (ack.duplicate) {
        metrics.duplicate_total += 1;
      }

      return ack;
    },

    getMetrics() {
      return { ...metrics };
    },
  };
}
