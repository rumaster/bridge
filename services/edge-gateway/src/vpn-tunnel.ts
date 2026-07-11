import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

import { validateEdgeTunnelMessage } from "../../../packages/contracts/src/c9.js";

/**
 * VPN Tunnel Service — защищённый канал Edge↔App (ТЗ §7.8, CP-7).
 *
 * Модель канала между Edge Cluster (РФ) и Application-контуром. Свойства §7.8:
 *   - взаимная аутентификация (mTLS): обе стороны предъявляют сертификат и
 *     проверяют сертификат партнёра по своему trust-store; недоверенный
 *     сертификат отвергается на любой стороне;
 *   - шифрование в канале: C9-сообщение запечатывается AES-256-GCM под сеансовым
 *     ключом, выведенным на handshake (HKDF от pre-shared секрета + нонсы сторон);
 *   - контроль соединения: send до connect и по разорванному каналу — ошибка;
 *   - авто-восстановление: повторный handshake по backoff после разрыва;
 *   - backpressure: при переполнении App-стороны send сигнализирует перегрузку,
 *     чтобы Edge буферизировал, а не терял сообщения.
 *
 * Реализация детерминированная (без реальных сокетов): «провод» — общий объект
 * link между сторонами; sealing даёт настоящий шифртекст, поэтому шифрование в
 * канале и контроль целостности проверяемы. Секреты (session key, сертификаты)
 * приходят из секрет-менеджера (мастер §2), а не из кода.
 */

const ALGORITHM = "aes-256-gcm";
const ENVELOPE_VERSION = 1;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + AUTH_TAG_BYTES;
const SESSION_KEY_BYTES = 32;
const HKDF_INFO = "bridge-vpn-tunnel/session-key/v1";

/** Требуемая длина pre-shared секрета туннеля (base64/hex/utf8 → 32 байта). */
export const VPN_SESSION_SECRET_BYTES = 32;

export class VpnTunnelError extends Error {
  constructor(message) {
    super(message);
    this.name = "VpnTunnelError";
  }
}

/** Отказ взаимной аутентификации mTLS (недоверенный сертификат). */
export class VpnTunnelAuthError extends VpnTunnelError {
  constructor(message) {
    super(message);
    this.name = "VpnTunnelAuthError";
  }
}

/** Канал недоступен (разрыв VPN Tunnel). */
export class VpnTunnelChannelDownError extends VpnTunnelError {
  constructor(message) {
    super(message);
    this.name = "VpnTunnelChannelDownError";
  }
}

/** App-сторона перегружена — сигнал backpressure для буферизации на Edge. */
export class VpnTunnelBackpressureError extends VpnTunnelError {
  constructor(message) {
    super(message);
    this.name = "VpnTunnelBackpressureError";
  }
}

function normalizeSecret(secret) {
  if (Buffer.isBuffer(secret)) {
    return secret;
  }
  if (typeof secret === "string" && secret.length > 0) {
    const trimmed = secret.trim();
    for (const encoding of ["base64", "hex"] as const) {
      const candidate = Buffer.from(trimmed, encoding);
      if (candidate.length === VPN_SESSION_SECRET_BYTES) {
        return candidate;
      }
    }
    return Buffer.from(trimmed, "utf8");
  }
  throw new VpnTunnelError("session secret must be a non-empty Buffer or string");
}

/**
 * Достаёт pre-shared секрет туннеля из окружения (секрет-менеджер), НЕ из кода.
 */
export function resolveVpnSessionSecret(env = process.env, variableName = "EDGE_VPN_SESSION_KEY") {
  const raw = env?.[variableName];
  if (!raw) {
    throw new VpnTunnelError(
      `VPN tunnel session secret is not configured (${variableName} via secret manager)`,
    );
  }
  const secret = normalizeSecret(raw);
  if (secret.length < 16) {
    throw new VpnTunnelError(`${variableName} is too short for a VPN session secret`);
  }
  return secret;
}

/** Выводит сеансовый ключ из pre-shared секрета и нонсов сторон (HKDF-SHA256). */
function deriveSessionKey(secret, clientNonce, serverNonce) {
  const salt = Buffer.concat([clientNonce, serverNonce]);
  return Buffer.from(hkdfSync("sha256", secret, salt, HKDF_INFO, SESSION_KEY_BYTES));
}

function normalizeAad(aad) {
  const ordered = {};
  for (const field of Object.keys(aad).sort()) {
    ordered[field] = aad[field];
  }
  return Buffer.from(JSON.stringify(ordered), "utf8");
}

/**
 * Запечатывает JSON в конверт [ver|iv|tag|ct] под сеансовым ключом.
 * Экспортируется как {@link sealTunnelFrame} для control-plane (Этап E2),
 * который переиспользует ту же mTLS+AES-256-GCM сессию для App→Edge кадров.
 */
function seal(sessionKey, plaintextObject, aad, ivFactory) {
  const iv = ivFactory();
  const cipher = createCipheriv(ALGORITHM, sessionKey, iv);
  cipher.setAAD(normalizeAad(aad));
  const plaintext = Buffer.from(JSON.stringify(plaintextObject), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([ENVELOPE_VERSION]), iv, authTag, ciphertext]);
}

/** Распечатывает конверт обратно в объект; бросает при нарушении целостности. */
function open(sessionKey, frame, aad) {
  const buffer = Buffer.isBuffer(frame) ? frame : Buffer.from(frame ?? []);
  if (buffer.length < HEADER_BYTES || buffer[0] !== ENVELOPE_VERSION) {
    throw new VpnTunnelError("malformed VPN tunnel frame");
  }
  const iv = buffer.subarray(1, 1 + IV_BYTES);
  const authTag = buffer.subarray(1 + IV_BYTES, HEADER_BYTES);
  const ciphertext = buffer.subarray(HEADER_BYTES);
  const decipher = createDecipheriv(ALGORITHM, sessionKey, iv);
  decipher.setAAD(normalizeAad(aad));
  decipher.setAuthTag(authTag);
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new VpnTunnelError("VPN tunnel frame integrity check failed");
  }
  return JSON.parse(plaintext.toString("utf8"));
}

function certificatesEqual(a, b) {
  const left = Buffer.from(String(a), "utf8");
  const right = Buffer.from(String(b), "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function makeTrustVerifier(trustedCertificates, verify) {
  if (typeof verify === "function") {
    return verify;
  }
  const trusted = Array.isArray(trustedCertificates) ? trustedCertificates : [];
  return (certificate) => trusted.some((entry) => certificatesEqual(entry, certificate));
}

/**
 * Общий «провод» между Edge и App. Разрыв канала моделируется cut()/restore().
 */
export function createVpnLink({ up = true } = {}) {
  let online = Boolean(up);
  return {
    isUp() {
      return online;
    },
    cut() {
      online = false;
    },
    restore() {
      online = true;
    },
  };
}

/**
 * App-сторона VPN Tunnel (терминатор в Application-контуре).
 * @param {object} options
 * @param {{ id: string, certificate: string }} options.identity серверный сертификат
 * @param {string[]} [options.trustedCertificates] доверенные клиентские (Edge) сертификаты
 * @param {(certificate: string, hello: object) => boolean} [options.authenticatePeer]
 * @param {Buffer|string} options.sessionSecret pre-shared секрет туннеля (секрет-менеджер)
 * @param {(tunnelMessage: object) => any} options.handle обработчик валидного C9 (напр. edge intake)
 * @param {number} [options.capacity] предел одновременно обрабатываемых сообщений (backpressure)
 * @param {ReturnType<typeof createVpnLink>} [options.link]
 * @param {() => Buffer} [options.nonceFactory]
 */
export interface VpnTunnelIdentity {
  id: string;
  certificate?: string;
}

export interface VpnTunnelClientHello {
  certificate?: string;
  nonce?: Buffer;
  clientId?: string;
}

export interface VpnTunnelDeliverOptions {
  sessionId?: string;
  frame?: any;
  aad?: any;
  message?: any;
}

export interface CreateVpnTunnelAppEndpointOptions {
  identity?: VpnTunnelIdentity;
  trustedCertificates?: string[];
  authenticatePeer?: (certificate: any, hello: any) => boolean;
  sessionSecret?: Buffer | string;
  handle?: (tunnelMessage: any) => any;
  capacity?: number;
  link?: ReturnType<typeof createVpnLink>;
  nonceFactory?: () => Buffer;
  appCrypto?: boolean;
}

export function createVpnTunnelAppEndpoint({
  identity,
  trustedCertificates,
  authenticatePeer,
  sessionSecret,
  handle,
  capacity = Number.POSITIVE_INFINITY,
  link = createVpnLink(),
  nonceFactory = () => randomBytes(16),
  // appCrypto=false — единый слой (Q2): конфиденциальность и взаимную
  // аутентификацию обеспечивает AmneziaWG-туннель, прикладной AES-GCM/mTLS
  // снят. RPC-плоскость доставки C9 (handshake/deliver) сохраняется без крипто
  // (Q4) — она несёт ack/backpressure/дедуп-сигналы. По умолчанию true
  // (обратная совместимость: mock/дев-режим без реального туннеля).
  appCrypto = true,
}: CreateVpnTunnelAppEndpointOptions = {}) {
  if (!identity?.id || (appCrypto && !identity?.certificate)) {
    throw new VpnTunnelError(
      appCrypto
        ? "App endpoint identity {id, certificate} is required"
        : "App endpoint identity {id} is required",
    );
  }
  if (typeof handle !== "function") {
    throw new VpnTunnelError("handle(tunnelMessage) is required");
  }
  const secret = appCrypto ? normalizeSecret(sessionSecret) : null;
  const verifyPeer = appCrypto ? makeTrustVerifier(trustedCertificates, authenticatePeer) : null;
  const sessions = new Map();
  let paused = false;
  let inFlight = 0;
  const metrics = {
    handshake_total: 0,
    handshake_rejected_total: 0,
    delivered_total: 0,
    duplicate_total: 0,
    rejected_total: 0,
    backpressure_total: 0,
    channel_down_total: 0,
  };

  return {
    identity: { id: identity.id, certificate: identity.certificate },
    link,

    /** Приём handshake от Edge: взаимная mTLS-проверка + установка сессии. */
    handshake(clientHello: VpnTunnelClientHello = {}) {
      if (!link.isUp()) {
        metrics.channel_down_total += 1;
        throw new VpnTunnelChannelDownError("VPN tunnel channel is down during handshake");
      }
      if (!appCrypto) {
        // Единый слой: аутентификация и шифрование — на AmneziaWG. Здесь лишь
        // устанавливаем сессию доставки C9 (routing + дедуп), без mTLS и ключа.
        const serverNonce = nonceFactory();
        const sessionId = `${identity.id}:${clientHello.clientId ?? "edge"}:${serverNonce.toString("hex").slice(0, 12)}`;
        sessions.set(sessionId, { sessionKey: null, seen: new Map() });
        metrics.handshake_total += 1;
        return { sessionId, serverId: identity.id };
      }
      // Проверяем клиентский сертификат Edge (серверная сторона mTLS).
      if (!clientHello.certificate || !verifyPeer(clientHello.certificate, clientHello)) {
        metrics.handshake_rejected_total += 1;
        throw new VpnTunnelAuthError("Edge client certificate is not trusted (mTLS)");
      }
      if (!Buffer.isBuffer(clientHello.nonce) || clientHello.nonce.length === 0) {
        throw new VpnTunnelAuthError("client nonce is required for session key derivation");
      }
      const serverNonce = nonceFactory();
      const sessionKey = deriveSessionKey(secret, clientHello.nonce, serverNonce);
      const sessionId = `${identity.id}:${clientHello.clientId ?? "edge"}:${serverNonce.toString("hex").slice(0, 12)}`;
      sessions.set(sessionId, { sessionKey, seen: new Map() });
      metrics.handshake_total += 1;
      // Серверный сертификат отдаётся Edge для проверки (клиентская сторона mTLS).
      return {
        sessionId,
        serverId: identity.id,
        certificate: identity.certificate,
        serverNonce,
      };
    },

    /** Приём C9-кадра: (рас)шифровка при appCrypto, валидация, обработка, ack. */
    async deliver({ sessionId, frame, aad, message }: VpnTunnelDeliverOptions = {}) {
      if (!link.isUp()) {
        metrics.channel_down_total += 1;
        throw new VpnTunnelChannelDownError("VPN tunnel channel is down");
      }
      const session = sessions.get(sessionId);
      if (!session) {
        metrics.rejected_total += 1;
        throw new VpnTunnelAuthError("unknown VPN tunnel session (handshake required)");
      }
      if (paused || inFlight >= capacity) {
        metrics.backpressure_total += 1;
        throw new VpnTunnelBackpressureError("App endpoint is at capacity (backpressure)");
      }

      // Единый слой: C9 идёт открытым внутри зашифрованного туннеля (Q2/Q4).
      const tunnelMessage = appCrypto ? open(session.sessionKey, frame, aad) : message;

      const validation = validateEdgeTunnelMessage(tunnelMessage);
      if (!validation.valid) {
        metrics.rejected_total += 1;
        throw new VpnTunnelError(`Invalid C9 tunnel message: ${validation.errors.join("; ")}`);
      }

      inFlight += 1;
      try {
        const ack = await handle(tunnelMessage);
        metrics.delivered_total += 1;
        if (ack?.duplicate === true) {
          metrics.duplicate_total += 1;
        }
        return ack;
      } finally {
        inFlight -= 1;
      }
    },

    /** Ручное включение backpressure (перегрузка App). */
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    isPaused() {
      return paused;
    },
    inFlightCount() {
      return inFlight;
    },
    getMetrics() {
      return { ...metrics, open_sessions: sessions.size };
    },
  };
}

/**
 * Edge-сторона VPN Tunnel (клиент в РФ-контуре).
 * @param {object} options
 * @param {{ id: string, certificate: string }} options.identity клиентский (Edge) сертификат
 * @param {ReturnType<typeof createVpnTunnelAppEndpoint>} options.server App-сторона туннеля
 * @param {string[]} [options.trustedCertificates] доверенные серверные сертификаты
 * @param {(certificate: string, hello: object) => boolean} [options.verifyServer]
 * @param {Buffer|string} options.sessionSecret pre-shared секрет туннеля (секрет-менеджер)
 * @param {ReturnType<typeof createVpnLink>} [options.link]
 * @param {number[]} [options.backoff] расписание задержек авто-восстановления (мс)
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {() => Buffer} [options.nonceFactory]
 * @param {() => Buffer} [options.ivFactory]
 * @param {string} [options.clientId]
 */
export interface CreateVpnTunnelEdgeClientOptions {
  identity?: VpnTunnelIdentity;
  server?: any;
  trustedCertificates?: string[];
  verifyServer?: (certificate: any, hello: any) => boolean;
  sessionSecret?: Buffer | string;
  link?: ReturnType<typeof createVpnLink>;
  backoff?: number[];
  sleep?: (ms: number) => Promise<void>;
  nonceFactory?: () => Buffer;
  ivFactory?: () => Buffer;
  clientId?: string;
  appCrypto?: boolean;
}

export function createVpnTunnelEdgeClient({
  identity,
  server,
  trustedCertificates,
  verifyServer,
  sessionSecret,
  link = server?.link ?? createVpnLink(),
  backoff = [10, 50, 100, 250, 500],
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  nonceFactory = () => randomBytes(16),
  ivFactory = () => randomBytes(IV_BYTES),
  clientId = "edge",
  // См. createVpnTunnelAppEndpoint: appCrypto=false — единый слой (Q2), крипто
  // делегировано AmneziaWG. Обе стороны должны совпадать по appCrypto.
  appCrypto = true,
}: CreateVpnTunnelEdgeClientOptions = {}) {
  if (!identity?.id || (appCrypto && !identity?.certificate)) {
    throw new VpnTunnelError(
      appCrypto
        ? "Edge client identity {id, certificate} is required"
        : "Edge client identity {id} is required",
    );
  }
  if (!server || typeof server.handshake !== "function" || typeof server.deliver !== "function") {
    throw new VpnTunnelError("server (App endpoint) is required");
  }
  const secret = appCrypto ? normalizeSecret(sessionSecret) : null;
  const verifyPeer = appCrypto ? makeTrustVerifier(trustedCertificates, verifyServer) : null;

  let session = null; // { sessionId, sessionKey, serverId }
  const metrics = {
    connect_total: 0,
    reconnect_total: 0,
    handshake_failed_total: 0,
    sent_total: 0,
    backpressure_total: 0,
    channel_down_total: 0,
  };

  function establish() {
    const clientNonce = nonceFactory();
    const serverHello = server.handshake({
      clientId,
      certificate: identity.certificate,
      nonce: clientNonce,
    });
    if (serverHello && typeof serverHello.then === "function") {
      throw new VpnTunnelError("async VPN tunnel server requires connectAsync()/ensureConnected()");
    }
    finishEstablish(clientNonce, serverHello);
  }

  async function establishAsync() {
    const clientNonce = nonceFactory();
    const serverHello = await server.handshake({
      clientId,
      certificate: identity.certificate,
      nonce: clientNonce,
    });
    finishEstablish(clientNonce, serverHello);
  }

  function finishEstablish(clientNonce, serverHello) {
    if (!appCrypto) {
      // Единый слой: сессия без mTLS/ключа (доверие — на ключах WG туннеля).
      if (!serverHello?.sessionId) {
        metrics.handshake_failed_total += 1;
        throw new VpnTunnelError("App server did not establish a tunnel session");
      }
      session = {
        sessionId: serverHello.sessionId,
        sessionKey: null,
        serverId: serverHello.serverId,
      };
      return;
    }
    // Проверяем серверный сертификат App (клиентская сторона mTLS).
    if (!serverHello?.certificate || !verifyPeer(serverHello.certificate, serverHello)) {
      metrics.handshake_failed_total += 1;
      throw new VpnTunnelAuthError("App server certificate is not trusted (mTLS)");
    }
    const sessionKey = deriveSessionKey(secret, clientNonce, serverHello.serverNonce);
    session = {
      sessionId: serverHello.sessionId,
      sessionKey,
      serverId: serverHello.serverId,
    };
  }

  const client = {
    /** Устанавливает туннель: взаимный handshake mTLS + вывод сеансового ключа. */
    connect() {
      if (!link.isUp()) {
        metrics.channel_down_total += 1;
        throw new VpnTunnelChannelDownError("VPN tunnel channel is down");
      }
      establish();
      metrics.connect_total += 1;
      return { sessionId: session.sessionId, serverId: session.serverId };
    },

    /** Async-вариант connect() для реального TCP/TLS/WSS транспорта. */
    async connectAsync() {
      if (!link.isUp()) {
        metrics.channel_down_total += 1;
        throw new VpnTunnelChannelDownError("VPN tunnel channel is down");
      }
      await establishAsync();
      metrics.connect_total += 1;
      return { sessionId: session.sessionId, serverId: session.serverId };
    },

    isConnected() {
      return session !== null && link.isUp();
    },

    disconnect() {
      session = null;
    },

    /** Отправляет C9-сообщение через туннель (шифрование в канале + ack App). */
    async send(tunnelMessage) {
      if (session === null) {
        throw new VpnTunnelError("VPN tunnel is not connected (call connect first)");
      }
      if (!link.isUp()) {
        session = null;
        metrics.channel_down_total += 1;
        throw new VpnTunnelChannelDownError("VPN tunnel channel is down");
      }
      const aad = {
        session_id: session.sessionId,
        endpoint_id: tunnelMessage.endpoint_id,
        sequence_number: tunnelMessage.sequence_number,
        idempotency_key: tunnelMessage.idempotency_key,
      };
      // Единый слой: без seal — C9 идёт открытым внутри туннеля (Q2/Q4).
      const deliverArgs = appCrypto
        ? { sessionId: session.sessionId, frame: seal(session.sessionKey, tunnelMessage, aad, ivFactory), aad }
        : { sessionId: session.sessionId, message: tunnelMessage, aad };
      try {
        const ack = await server.deliver(deliverArgs);
        metrics.sent_total += 1;
        return ack;
      } catch (error) {
        if (error instanceof VpnTunnelBackpressureError) {
          metrics.backpressure_total += 1;
        } else if (error instanceof VpnTunnelChannelDownError) {
          session = null;
          metrics.channel_down_total += 1;
        }
        throw error;
      }
    },

    /**
     * Авто-восстановление: переустановка туннеля по backoff после разрыва.
     * @param {object} [options]
     * @param {number} [options.maxAttempts]
     */
    async ensureConnected({ maxAttempts = backoff.length + 1 } = {}) {
      if (this.isConnected()) {
        return { reconnected: false, attempts: 0 };
      }
      let attempts = 0;
      let lastError;
      while (attempts < maxAttempts) {
        if (link.isUp()) {
          try {
            await establishAsync();
            metrics.reconnect_total += 1;
            return { reconnected: true, attempts: attempts + 1 };
          } catch (error) {
            lastError = error;
          }
        } else {
          lastError = new VpnTunnelChannelDownError("VPN tunnel channel is down");
        }
        const delay = backoff[Math.min(attempts, backoff.length - 1)] ?? 0;
        await sleep(delay);
        attempts += 1;
      }
      throw lastError ?? new VpnTunnelChannelDownError("VPN tunnel auto-recovery exhausted");
    },

    getMetrics() {
      return { ...metrics, connected: this.isConnected() };
    },
  };

  return client;
}

// Примитивы кадра туннеля для control-plane (Этап E2): control-канал App→Edge
// переиспользует сеансовый ключ и формат кадра data-plane, а не заводит свою
// криптографию. IV_BYTES экспортируется, чтобы транспорт генерировал корректный IV.
export { seal as sealTunnelFrame, open as openTunnelFrame };
export const TUNNEL_FRAME_IV_BYTES = IV_BYTES;
