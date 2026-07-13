import { VpnTunnelChannelDownError } from "./vpn-tunnel.js";
import type { EdgeControlTransport } from "./edge-control-client.js";

/**
 * Реальный (сетевой) транспорт App→Edge control-plane поверх VPN-туннеля
 * (Этап E2/MP-12). Доводит заготовку `edge-control-tunnel.ts` (in-process) до
 * настоящего сокета: App-сторона (`edge-vpn-app`) дозванивается до control-
 * listener'а Edge по туннельному IP и толкает `C9.EdgeControlMessage`, Edge
 * возвращает `C9.EdgeControlAck`.
 *
 * Транспорт-агностичность сохранена: `remote` — это RPC-клиент из
 * `vpn-transport.ts` (`createVpnTunnelTcpRemoteServer` /
 * `createVpnTunnelWebSocketRemoteServer` / failover), у которого есть метод
 * `control(message)`. Крипто/взаимную аутентификацию канала обеспечивает сам
 * AmneziaWG-туннель (единый слой, Q2) — прикладной seal не дублируется, как и в
 * data-plane при `EDGE_VPN_APP_CRYPTO=off`.
 *
 * Разрыв туннеля проявляется двумя путями и оба сводятся к
 * {@link VpnTunnelChannelDownError}, который `createEdgeControlClient`
 * переводит в офлайн-очередь:
 *   - проактивно — `link.isUp()` (TCP-liveness туннельного IP Edge) ложится → мы
 *     не тратим TCP-timeout на каждое сообщение, а сразу сигналим «канал лёг»;
 *   - реактивно — сам `remote.control()` бросает channel-down при отказе connect.
 */

export interface TunnelControlRemote {
  control(message: unknown): Promise<unknown>;
  getMetrics?(): Record<string, unknown>;
}

export interface CreateTunnelEdgeControlTransportOptions {
  remote: TunnelControlRemote;
  /** Опциональный liveness-переключатель туннеля (createLivenessLink/createVpnLink). */
  link?: { isUp(): boolean };
}

export function createTunnelEdgeControlTransport({
  remote,
  link,
}: CreateTunnelEdgeControlTransportOptions): EdgeControlTransport {
  if (!remote || typeof remote.control !== "function") {
    throw new Error("createTunnelEdgeControlTransport requires a remote with control()");
  }

  return {
    isConnected() {
      return link ? link.isUp() : true;
    },

    async send(message: unknown) {
      if (link && !link.isUp()) {
        // Проактивный сигнал разрыва: очередь примет сообщение без TCP-таймаута.
        throw new VpnTunnelChannelDownError("edge control channel is down (liveness)");
      }
      return remote.control(message);
    },
  };
}
