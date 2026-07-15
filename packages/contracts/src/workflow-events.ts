/**
 * Реестр событий, на которые может подписаться узел «Ожидание события».
 *
 * Живёт отдельным модулем без импортов (как `c5-workflow.ts`) — его одинаково
 * грузят редактор в браузере, CommonJS-сборка Backend и движок.
 *
 * Ревизия 2026-07-15 (решение A2). Ключевое правило: **в реестре только те
 * события, которые кто-то действительно публикует**. В `C7_EVENT_TYPES` объявлено
 * девять типов, но публикуются ровно два (`c7-realtime-event.publisher.ts`);
 * остальные семь — словарь на будущее. Положить их в селектбокс значило бы дать
 * оператору построить схему, которая молча никогда не сработает, поэтому они
 * вынесены в `WORKFLOW_PLANNED_EVENT_TYPES` и показываются недоступными с
 * объяснением.
 *
 * Как добавить событие: появился публикатор — заведите запись здесь и уберите
 * тип из `WORKFLOW_PLANNED_EVENT_TYPES`. Расхождение ловит контрактный тест.
 */

/** Поля, по которым подписку можно сузить до конкретной сущности. */
export const WORKFLOW_CORRELATION_FIELDS = Object.freeze([
  "conversation_id",
  "client_id",
  "channel_id",
  "endpoint_id",
  "message_id",
] as const);

export type WorkflowCorrelationField = (typeof WORKFLOW_CORRELATION_FIELDS)[number];

export interface WorkflowEventDefinition {
  /** Тип события; совпадает со значением из C7_EVENT_TYPES. */
  readonly event_type: string;
  readonly label: string;
  readonly description: string;
  /** JSON Schema полезной нагрузки — то, что придёт на порт `data`. */
  readonly payload_schema: Record<string, unknown>;
  /** Образец нагрузки: предзаполняет форму тест-прогона (решение A6). */
  readonly sample_payload: Record<string, unknown>;
  /** Поля, доступные для сужения подписки. */
  readonly correlation_fields: readonly WorkflowCorrelationField[];
}

const MESSAGE_CREATED: WorkflowEventDefinition = {
  event_type: "message.created",
  label: "Получено сообщение",
  description: "Публикуется при создании сообщения в диалоге — входящего или исходящего.",
  payload_schema: {
    type: "object",
    required: ["message"],
    properties: {
      message: {
        type: "object",
        required: ["id", "conversationId", "direction", "text"],
        properties: {
          id: { type: "string" },
          conversationId: { type: "string" },
          clientId: { type: "string" },
          channelId: { type: "string" },
          direction: { type: "string", enum: ["inbound", "outbound"] },
          text: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
    },
  },
  sample_payload: {
    message: {
      id: "00000000-0000-0000-0000-000000000001",
      conversationId: "00000000-0000-0000-0000-000000000002",
      clientId: "00000000-0000-0000-0000-000000000003",
      channelId: "00000000-0000-0000-0000-000000000004",
      direction: "inbound",
      text: "Здравствуйте! Подскажите статус заказа.",
      createdAt: "2026-07-15T10:00:00.000Z",
    },
  },
  correlation_fields: ["conversation_id", "client_id", "channel_id"],
};

const MESSAGE_STATUS_CHANGED: WorkflowEventDefinition = {
  event_type: "message.status_changed",
  label: "Изменился статус сообщения",
  description: "Публикуется при смене статуса доставки сообщения (sent, delivered, failed и т. п.).",
  payload_schema: {
    type: "object",
    required: ["message_id", "status"],
    properties: {
      message_id: { type: "string" },
      status: { type: "string" },
    },
  },
  sample_payload: {
    message_id: "00000000-0000-0000-0000-000000000001",
    status: "delivered",
  },
  correlation_fields: ["message_id", "conversation_id"],
};

export const WORKFLOW_EVENT_DEFINITIONS: readonly WorkflowEventDefinition[] = Object.freeze([
  MESSAGE_CREATED,
  MESSAGE_STATUS_CHANGED,
]);

export const WORKFLOW_EVENT_TYPES: readonly string[] = Object.freeze(
  WORKFLOW_EVENT_DEFINITIONS.map((definition) => definition.event_type),
);

/**
 * Типы из словаря C7, которые пока никто не публикует. Показываются в редакторе
 * недоступными: подписка на них никогда бы не сработала.
 */
export const WORKFLOW_PLANNED_EVENT_TYPES: readonly string[] = Object.freeze([
  "typing.started",
  "typing.stopped",
  "client.status_changed",
  "channel.status_changed",
  "notification.created",
  "broadcast.state_changed",
  "workflow.state_changed",
]);

const BY_TYPE = new Map<string, WorkflowEventDefinition>(
  WORKFLOW_EVENT_DEFINITIONS.map((definition) => [definition.event_type, definition]),
);

export function getWorkflowEventDefinition(eventType: string): WorkflowEventDefinition | null {
  return BY_TYPE.get(eventType) ?? null;
}

export function isWorkflowEventType(value: unknown): boolean {
  return typeof value === "string" && BY_TYPE.has(value);
}

export function isPlannedWorkflowEventType(value: unknown): boolean {
  return typeof value === "string" && WORKFLOW_PLANNED_EVENT_TYPES.includes(value);
}

/** Причина, по которой тип события недоступен, — для подсказки в редакторе. */
export function workflowEventUnavailableReason(eventType: string): string | null {
  if (isWorkflowEventType(eventType)) return null;
  if (isPlannedWorkflowEventType(eventType)) {
    return `Событие «${eventType}» объявлено в контракте C7, но пока не публикуется ни одним сервисом — подписка не сработает.`;
  }
  return `Неизвестный тип события «${eventType}».`;
}
