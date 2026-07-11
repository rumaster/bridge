import { createEdgeControlMessage } from "../../../packages/contracts/src/c9.js";

import { VpnTunnelBackpressureError, VpnTunnelChannelDownError } from "./vpn-tunnel.js";

/**
 * App-сторона control-plane туннеля (Этап E2). Отправляет App→Edge control-
 * сообщения (`channel_credentials_sync`, `egress_dispatch`) через инъектируемый
 * транспорт и **не теряет их при разрыве туннеля**: недоставленные встают в
 * офлайн-очередь и дренажируются при восстановлении связи — симметрично тому, как
 * Edge буферизует входящее в RF-буфере (см. `edge-cluster.ts`).
 *
 * Транспорт-агностичен: `transport` может быть реальной VPN-сессией
 * (`edge-control-tunnel.ts`) или любым другим каналом. Идемпотентность
 * гарантируется стабильным `control_id`, который дедуплицирует Edge, поэтому
 * повторная отправка из очереди безопасна.
 */

export interface EdgeControlTransport {
  isConnected(): boolean;
  send(message: unknown): Promise<unknown>;
}

export interface CreateEdgeControlClientOptions {
  transport: EdgeControlTransport;
  now?: () => string;
  /** Предел офлайн-очереди; при переполнении вытесняется самый старый элемент. */
  maxQueue?: number;
}

export interface DispatchResult {
  queued: boolean;
  ack?: unknown;
  reason?: string;
}

export interface DrainResult {
  drained: number;
  remaining: number;
  reason?: string;
}

export function createEdgeControlClient({
  transport,
  now = () => new Date().toISOString(),
  maxQueue = 1024,
}: CreateEdgeControlClientOptions) {
  if (!transport || typeof transport.send !== "function") {
    throw new Error("createEdgeControlClient requires a transport with send()");
  }

  const queue: unknown[] = [];
  const metrics = {
    sent_total: 0,
    queued_total: 0,
    drained_total: 0,
    dropped_total: 0,
  };

  async function trySend(
    message: unknown,
  ): Promise<{ delivered: boolean; ack?: unknown; reason?: string }> {
    if (typeof transport.isConnected === "function" && !transport.isConnected()) {
      return { delivered: false, reason: "disconnected" };
    }
    try {
      const ack = await transport.send(message);
      metrics.sent_total += 1;
      return { delivered: true, ack };
    } catch (error) {
      // Разрыв канала и backpressure — повторяемые: сообщение уходит в очередь.
      if (error instanceof VpnTunnelChannelDownError) {
        return { delivered: false, reason: "channel_down" };
      }
      if (error instanceof VpnTunnelBackpressureError) {
        return { delivered: false, reason: "backpressure" };
      }
      throw error;
    }
  }

  function enqueue(message: unknown): void {
    if (queue.length >= maxQueue) {
      queue.shift();
      metrics.dropped_total += 1;
    }
    queue.push(message);
    metrics.queued_total += 1;
  }

  async function dispatch(message: unknown): Promise<DispatchResult> {
    const result = await trySend(message);
    if (result.delivered) {
      return { queued: false, ack: result.ack };
    }

    enqueue(message);
    return { queued: true, reason: result.reason };
  }

  return {
    /** Проталкивает структурные креды email-канала на Edge (идемпотентно по controlId). */
    syncCredentials({
      organizationId,
      controlId,
      channelId,
      channelType = "email",
      credentials,
      issuedAt,
    }: {
      organizationId: string;
      controlId: string;
      channelId: string;
      channelType?: string;
      credentials: unknown;
      issuedAt?: string;
    }): Promise<DispatchResult> {
      return dispatch(
        createEdgeControlMessage({
          type: "channel_credentials_sync",
          organizationId,
          controlId,
          issuedAt: issuedAt ?? now(),
          payload: { channel_id: channelId, channel_type: channelType, credentials },
        }),
      );
    },

    /** Поручает Edge отправить исходящее письмо (идемпотентно по controlId). */
    dispatchEgress({
      organizationId,
      controlId,
      delivery,
      issuedAt,
    }: {
      organizationId: string;
      controlId: string;
      delivery: Record<string, unknown>;
      issuedAt?: string;
    }): Promise<DispatchResult> {
      return dispatch(
        createEdgeControlMessage({
          type: "egress_dispatch",
          organizationId,
          controlId,
          issuedAt: issuedAt ?? now(),
          payload: delivery,
        }),
      );
    },

    /** Отправка произвольного уже собранного control-сообщения. */
    dispatch,

    /** Дренаж офлайн-очереди после восстановления связи (в порядке FIFO). */
    async drain(): Promise<DrainResult> {
      let drained = 0;
      while (queue.length > 0) {
        const message = queue[0];
        const result = await trySend(message);
        if (!result.delivered) {
          return { drained, remaining: queue.length, reason: result.reason };
        }
        queue.shift();
        drained += 1;
        metrics.drained_total += 1;
      }

      return { drained, remaining: 0 };
    },

    pendingCount(): number {
      return queue.length;
    },

    getMetrics() {
      return { ...metrics, pending: queue.length };
    },
  };
}
