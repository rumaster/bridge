/**
 * Машина состояний статуса сообщения (контракт C1).
 *
 * Портирована из `packages/contracts/message-model/index.ts`
 * (`MESSAGE_STATUS`, `MESSAGE_STATUS_TRANSITIONS`, `assertMessageStatusTransition`)
 * в исполняемый TypeScript, компилируемый в `dist/main.js`. Ранее эта логика
 * существовала только в прототипах, которые не попадали в production-сборку
 * backend (см. issue #189, пункт 3).
 */

export const MESSAGE_STATUS = Object.freeze({
  RECEIVED: "received",
  ROUTED: "routed",
  SENT: "sent",
  DELIVERED: "delivered",
  FAILED: "failed",
} as const);

export type MessageStatus = (typeof MESSAGE_STATUS)[keyof typeof MESSAGE_STATUS];

export const MESSAGE_DIRECTION = Object.freeze({
  INBOUND: "inbound",
  OUTBOUND: "outbound",
} as const);

export type MessageDirection = (typeof MESSAGE_DIRECTION)[keyof typeof MESSAGE_DIRECTION];

export const MESSAGE_SENDER_TYPE = Object.freeze({
  CLIENT: "client",
  MANAGER: "manager",
  AI: "ai",
  BROADCAST: "broadcast",
  SYSTEM: "system",
} as const);

export type MessageSenderType =
  (typeof MESSAGE_SENDER_TYPE)[keyof typeof MESSAGE_SENDER_TYPE];

/**
 * Допустимые переходы статуса. Терминальные состояния (`delivered`, `failed`)
 * не имеют исходящих рёбер.
 */
export const MESSAGE_STATUS_TRANSITIONS: Readonly<Record<MessageStatus, readonly MessageStatus[]>> =
  Object.freeze({
    [MESSAGE_STATUS.RECEIVED]: Object.freeze([MESSAGE_STATUS.ROUTED, MESSAGE_STATUS.FAILED]),
    [MESSAGE_STATUS.ROUTED]: Object.freeze([MESSAGE_STATUS.SENT, MESSAGE_STATUS.FAILED]),
    [MESSAGE_STATUS.SENT]: Object.freeze([MESSAGE_STATUS.DELIVERED, MESSAGE_STATUS.FAILED]),
    [MESSAGE_STATUS.DELIVERED]: Object.freeze([]),
    [MESSAGE_STATUS.FAILED]: Object.freeze([]),
  });

/**
 * Проверяет, разрешён ли переход `fromStatus -> toStatus`, не выбрасывая исключение.
 */
export function canTransitionMessageStatus(
  fromStatus: MessageStatus,
  toStatus: MessageStatus,
): boolean {
  return MESSAGE_STATUS_TRANSITIONS[fromStatus]?.includes(toStatus) === true;
}

/**
 * Ошибка недопустимого перехода статуса сообщения.
 */
export class InvalidMessageStatusTransitionError extends Error {
  readonly fromStatus: MessageStatus;
  readonly toStatus: MessageStatus;

  constructor(fromStatus: MessageStatus, toStatus: MessageStatus) {
    super(`Invalid message status transition: ${fromStatus} -> ${toStatus}`);
    this.name = "InvalidMessageStatusTransitionError";
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}

/**
 * Утверждает переход `fromStatus -> toStatus`, выбрасывая
 * {@link InvalidMessageStatusTransitionError} для недопустимых рёбер.
 */
export function assertMessageStatusTransition(
  fromStatus: MessageStatus,
  toStatus: MessageStatus,
): void {
  if (!canTransitionMessageStatus(fromStatus, toStatus)) {
    throw new InvalidMessageStatusTransitionError(fromStatus, toStatus);
  }
}

function isMessageStatus(value: unknown): value is MessageStatus {
  return (
    typeof value === "string" &&
    (Object.values(MESSAGE_STATUS) as string[]).includes(value)
  );
}

/**
 * Безопасно приводит произвольную строку к {@link MessageStatus}, выбрасывая
 * ошибку, если значение не входит в перечисление.
 */
export function toMessageStatus(value: unknown): MessageStatus {
  if (!isMessageStatus(value)) {
    throw new Error(`Unsupported message status: ${String(value)}`);
  }

  return value;
}
