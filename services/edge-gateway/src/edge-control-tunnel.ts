import { randomBytes } from "node:crypto";

import {
  TUNNEL_FRAME_IV_BYTES,
  VpnTunnelChannelDownError,
  createVpnLink,
  openTunnelFrame,
  sealTunnelFrame,
} from "./vpn-tunnel.js";
import type { EdgeControlTransport } from "./edge-control-client.js";

/**
 * Транспорт control-plane поверх установленной VPN-сессии Edge↔App (Этап E2).
 *
 * Переиспользует сеансовый ключ и формат кадра data-plane
 * ({@link sealTunnelFrame}/{@link openTunnelFrame}, AES-256-GCM): App запечатывает
 * control-сообщение под сеансовым ключом, кадр «уходит» на Edge, там
 * распечатывается, обрабатывается control-plane, а ack тем же образом
 * запечатывается обратно. Разрыв канала моделируется `link.cut()/restore()` —
 * при разрыве `send` бросает {@link VpnTunnelChannelDownError}, что App-клиент
 * ({@link createEdgeControlClient}) переводит в офлайн-очередь.
 *
 * Реализация детерминированная (in-process, без реального сокета) — тот же
 * уровень зрелости, что и у data-plane `vpn-tunnel.ts` (реальный TCP/TLS-сокет —
 * отдельная веха MP-12). AAD связывает кадр с сессией и `control_id`, поэтому
 * подмена/переигровка между сессиями отвергается контролем целостности.
 */

export interface EdgeControlPlaneHandler {
  handle(message: unknown): Promise<unknown>;
}

export interface CreateInProcessEdgeControlTransportOptions {
  sessionId: string;
  sessionKey: Buffer;
  controlPlane: EdgeControlPlaneHandler;
  link?: ReturnType<typeof createVpnLink>;
  ivFactory?: () => Buffer;
}

export function createInProcessEdgeControlTransport({
  sessionId,
  sessionKey,
  controlPlane,
  link = createVpnLink(),
  ivFactory = () => randomBytes(TUNNEL_FRAME_IV_BYTES),
}: CreateInProcessEdgeControlTransportOptions): EdgeControlTransport & {
  link: ReturnType<typeof createVpnLink>;
} {
  if (!Buffer.isBuffer(sessionKey) || sessionKey.length !== 32) {
    throw new Error("sessionKey must be a 32-byte AES-256 session key");
  }
  if (!controlPlane || typeof controlPlane.handle !== "function") {
    throw new Error("controlPlane with handle() is required");
  }

  return {
    link,

    isConnected() {
      return link.isUp();
    },

    async send(message: any) {
      if (!link.isUp()) {
        throw new VpnTunnelChannelDownError("control channel is down");
      }

      const aad = {
        session_id: sessionId,
        control_id: message?.control_id,
        type: message?.type,
        organization_id: message?.organization_id,
      };
      // App-сторона: запечатываем кадр под сеансовым ключом.
      const frame = sealTunnelFrame(sessionKey, message, aad, ivFactory);

      // Edge-сторона: распечатываем, обрабатываем control-plane.
      const received = openTunnelFrame(sessionKey, frame, aad);
      const ack: any = await controlPlane.handle(received);

      // Ack запечатывается на Edge и распечатывается App (in-channel, оба конца).
      const ackAad = { session_id: sessionId, control_id: ack?.control_id };
      const ackFrame = sealTunnelFrame(sessionKey, ack, ackAad, ivFactory);
      return openTunnelFrame(sessionKey, ackFrame, ackAad);
    },
  };
}
