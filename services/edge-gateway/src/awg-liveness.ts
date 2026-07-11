import { connect as connectTcp } from "node:net";

/**
 * AmneziaWG liveness — контроль «жив ли туннель» на UDP (issue #257, Этап 2, §5.4).
 *
 * UDP-туннель бессоединённый, поэтому «up/down» определяется не сокетом, а:
 *   - свежестью последнего хендшейка (`awg show latest-handshakes`) —
 *     interpretHandshakeFreshness(); читается в namespace awg-контейнера;
 *   - активной пробой туннельного IP App-стороны из Edge —
 *     createTcpLivenessProbe(); работает прямо в Node-процессе edge-gateway,
 *     где awg-CLI нет, но туннельный IP достижим через awg0 общего namespace.
 *
 * Любой из сигналов питает createLivenessLink() — link, совместимый с
 * createVpnLink() (isUp/cut/restore), который edge-cluster уже использует как
 * переключатель «буферизация ↔ дренаж». Так проактивное обнаружение разрыва
 * дополняет реактивное (ошибка RPC-коннекта), не меняя логику буфера/дренажа.
 */

export interface HandshakeFreshness {
  up: boolean;
  ageMs: number | null;
}

/**
 * Трактовка «свежести хендшейка» → up/down. latestHandshakeEpochSec — unix-время
 * последнего хендшейка (0/undefined = хендшейка не было). Туннель «жив», если
 * хендшейк был и его возраст ≤ maxAgeMs.
 */
export function interpretHandshakeFreshness({
  latestHandshakeEpochSec,
  nowMs,
  maxAgeMs,
}: {
  latestHandshakeEpochSec: number | null | undefined;
  nowMs: number;
  maxAgeMs: number;
}): HandshakeFreshness {
  if (!latestHandshakeEpochSec || latestHandshakeEpochSec <= 0) {
    return { up: false, ageMs: null };
  }
  const ageMs = nowMs - latestHandshakeEpochSec * 1000;
  return { up: ageMs >= 0 && ageMs <= maxAgeMs, ageMs };
}

/**
 * Активная TCP-проба туннельного IP App-стороны (§5.4). Успешный connect =
 * туннель жив (пакет дошёл до App через awg0 и вернулся SYN-ACK).
 */
export function createTcpLivenessProbe({
  host,
  port,
  timeoutMs = 2_000,
}: {
  host: string;
  port: number;
  timeoutMs?: number;
}): () => Promise<boolean> {
  return () =>
    new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (up: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(up);
      };
      const socket = connectTcp({ host, port });
      socket.setTimeout(timeoutMs, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
}

export interface LivenessLink {
  isUp(): boolean;
  cut(): void;
  restore(): void;
  start(): void;
  stop(): void;
  lastProbeAt(): number | null;
}

/**
 * Link, управляемый пробой liveness: периодически опрашивает probe() и флипает
 * up/down. Совместим с интерфейсом createVpnLink() (isUp/cut/restore), поэтому
 * подставляется в createVpnTunnelEdgeClient({ link }) без изменений edge-cluster.
 */
export function createLivenessLink({
  probe,
  intervalMs = 5_000,
  initialUp = true,
  onChange,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  nowMs = () => Date.now(),
}: {
  probe: () => Promise<boolean>;
  intervalMs?: number;
  initialUp?: boolean;
  onChange?: (up: boolean) => void;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  nowMs?: () => number;
}): LivenessLink {
  let online = initialUp;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastAt: number | null = null;

  async function tick() {
    try {
      const up = await probe();
      lastAt = nowMs();
      if (up !== online) {
        online = up;
        onChange?.(up);
      }
    } catch {
      if (online) {
        online = false;
        onChange?.(false);
      }
    }
  }

  return {
    isUp() {
      return online;
    },
    cut() {
      if (online) {
        online = false;
        onChange?.(false);
      }
    },
    restore() {
      if (!online) {
        online = true;
        onChange?.(true);
      }
    },
    start() {
      if (timer) return;
      void tick();
      timer = setIntervalImpl(() => void tick(), intervalMs);
      (timer as any).unref?.();
    },
    stop() {
      if (timer) {
        clearIntervalImpl(timer);
        timer = undefined;
      }
    },
    lastProbeAt() {
      return lastAt;
    },
  };
}
