import { Injectable } from "@nestjs/common";

import {
  type EdgeTunnelAck,
  type EdgeTunnelMessage,
  createEdgeTunnelAck,
  normalizeEdgeTunnelMessage,
} from "./communication-core-m4.dto";
import { InternalMessagingService } from "./internal-messaging.service";
import { MESSAGE_STATUS } from "./message-status";

export interface EdgeIntakeBatchResult {
  received: number;
  accepted: number;
  forwarded: number;
  duplicates: number;
  reordered: boolean;
  acks: EdgeTunnelAck[];
}

@Injectable()
export class EdgeIntakeCoordinatorService {
  constructor(private readonly messaging: InternalMessagingService) {}

  async intake(tunnelMessage: EdgeTunnelMessage): Promise<EdgeTunnelAck> {
    const result = await this.intakeBatch([tunnelMessage]);

    return result.acks[0];
  }

  async intakeBatch(tunnelMessages: EdgeTunnelMessage[]): Promise<EdgeIntakeBatchResult> {
    const incoming = tunnelMessages.map((tunnelMessage, receivedIndex) => ({
      tunnelMessage: normalizeEdgeTunnelMessage(tunnelMessage, () => this.now()),
      receivedIndex,
    }));

    const seenInBatch = new Set<string>();
    const unique: typeof incoming = [];
    let batchDuplicates = 0;
    for (const item of incoming) {
      const key = item.tunnelMessage.idempotency_key;
      if (seenInBatch.has(key)) {
        batchDuplicates += 1;
        continue;
      }
      seenInBatch.add(key);
      unique.push(item);
    }

    const ordered = [...unique].sort((left, right) => {
      const leftEndpoint = left.tunnelMessage.endpoint_id;
      const rightEndpoint = right.tunnelMessage.endpoint_id;
      if (leftEndpoint !== rightEndpoint) {
        return leftEndpoint.localeCompare(rightEndpoint);
      }

      return left.tunnelMessage.sequence_number - right.tunnelMessage.sequence_number;
    });
    const reordered = ordered.some(
      (item, index) => index > 0 && ordered[index - 1].receivedIndex > item.receivedIndex,
    );

    const acks: EdgeTunnelAck[] = [];
    let forwarded = 0;
    let duplicates = batchDuplicates;
    for (const { tunnelMessage } of ordered) {
      const acceptance = await this.messaging.acceptIngress(tunnelMessage.payload);
      if (acceptance.duplicate) {
        duplicates += 1;
      } else {
        forwarded += 1;
      }

      acks.push(
        createEdgeTunnelAck({
          accepted: acceptance.accepted !== false,
          duplicate: acceptance.duplicate,
          messageId: acceptance.message_id,
          endpointId: tunnelMessage.endpoint_id,
          sequenceNumber: tunnelMessage.sequence_number,
          idempotencyKey: tunnelMessage.idempotency_key,
          coreStatus: acceptance.status || MESSAGE_STATUS.RECEIVED,
          receivedAt: this.now(),
        }),
      );
    }

    return {
      received: tunnelMessages.length,
      accepted: forwarded,
      forwarded,
      duplicates,
      reordered,
      acks,
    };
  }

  private now(): string {
    return new Date().toISOString();
  }
}
