import type {
  AdminRole,
  AdminSession,
  BroadcastCampaign,
  BroadcastStats,
  C7Event,
  Channel,
  ChannelCapabilityDescriptor,
  ChannelCapabilityName,
  KnowledgeDocument,
  Notification,
  NotificationCategory,
  NotificationChannel,
  NotificationSetting,
  OnboardingApplyResult,
  OnboardingCommand,
  OnboardingCommandAction,
  OnboardingCommandRequest,
  OnboardingCommandResponse,
  Organization,
  OrganizationConfiguration,
  Workflow,
  WorkflowInstance,
  WorkflowInstanceDetail,
  WorkflowInstanceLogEntry,
  WorkflowSchema,
  WorkflowVersion
} from "../client/types";

export const mockSession: AdminSession = {
  authenticated: true,
  user: {
    id: "00000000-0000-4000-8000-000000000101",
    organizationId: "org-demo",
    displayName: "Демо Администратор",
    telegramUsername: "admin_demo",
    status: "active"
  },
  organization: {
    id: "org-demo",
    slug: "demo-organization",
    name: "Демо Организация"
  },
  roles: ["administrator"],
  session: {
    id: "mock-session-m1",
    mode: "mock",
    issuedAt: "2026-07-03T09:00:00.000Z",
    expiresAt: null
  },
  implementationStage: "M1"
};

export const mockOrganization: Organization = {
  id: "org-demo",
  name: "Демо Организация",
  description: "Организация для проверки M1-входа и конфигурации админ-панели.",
  timezone: "Europe/Moscow",
  locale: "ru-RU",
  status: "active",
  updatedAt: "2026-07-02T16:10:00.000Z"
};

export const mockConfiguration: OrganizationConfiguration = {
  organizationId: "org-demo",
  defaultLanguage: "ru",
  aiAssistantEnabled: true,
  workflowAutomationEnabled: true,
  monthlyMessageLimit: 10000,
  notificationEmail: "admin@example.test",
  retentionDays: 90,
  updatedAt: "2026-07-03T09:12:00.000Z"
};

export const channelCapabilityNames: ChannelCapabilityName[] = [
  "text",
  "image",
  "file",
  "voice",
  "video",
  "buttons",
  "reactions",
  "typing_indicator",
  "read_receipt",
  "delete",
  "edit"
];

export const mockChannels: Channel[] = [
  {
    id: "channel-web-chat-main",
    organization_id: "org-demo",
    channel_type: "web_chat",
    name: "Основной Web Chat",
    status: "connected",
    credentials_ref: "secret://web-chat/org-demo/main",
    config: {
      widget_origin: "https://demo.example.test"
    },
    last_check_at: "2026-07-03T10:02:00.000Z",
    created_at: "2026-07-03T09:45:00.000Z",
    updated_at: "2026-07-03T10:02:00.000Z",
    error_log: []
  },
  {
    id: "channel-telegram-main",
    organization_id: "org-demo",
    channel_type: "telegram",
    name: "Telegram Support",
    status: "error",
    credentials_ref: "secret://telegram/org-demo/support-bot",
    config: {
      bot_username: "bridge_support_bot"
    },
    last_check_at: "2026-07-03T09:55:00.000Z",
    created_at: "2026-07-03T09:40:00.000Z",
    updated_at: "2026-07-03T09:55:00.000Z",
    error_log: [
      {
        id: "channel-error-telegram-webhook",
        code: "WEBHOOK_TIMEOUT",
        message: "Webhook не ответил за 5 секунд.",
        occurred_at: "2026-07-03T09:55:00.000Z"
      }
    ]
  }
];

export const mockKnowledgeDocuments: KnowledgeDocument[] = [
  {
    id: "kb-doc-returns",
    organization_id: "org-demo",
    title: "FAQ возвратов",
    source: "manual://returns",
    status: "indexed",
    indexed_at: "2026-07-03T09:30:00.000Z",
    created_at: "2026-07-03T09:10:00.000Z",
    updated_at: "2026-07-03T09:30:00.000Z",
    file_name: "returns.md",
    content_type: "text/markdown",
    size_bytes: 4096
  },
  {
    id: "kb-doc-delivery",
    organization_id: "org-demo",
    title: "Регламент доставки",
    source: "manual://delivery",
    status: "indexing",
    indexed_at: null,
    created_at: "2026-07-03T09:35:00.000Z",
    updated_at: "2026-07-03T09:36:00.000Z",
    file_name: "delivery.pdf",
    content_type: "application/pdf",
    size_bytes: 8192
  },
  {
    id: "kb-doc-prices",
    organization_id: "org-demo",
    title: "Прайс-лист",
    source: "manual://prices",
    status: "failed",
    indexed_at: null,
    created_at: "2026-07-03T09:15:00.000Z",
    updated_at: "2026-07-03T09:20:00.000Z",
    file_name: "prices.xlsx",
    content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size_bytes: 10240,
    error_message: "Файл содержит пустые обязательные колонки."
  }
];

export const mockC7Events: C7Event[] = [
  {
    type: "channel.status_changed",
    sequenceNumber: 1,
    payload: {
      channelId: "channel-telegram-main",
      status: "connected",
      lastCheckAt: "2026-07-03T10:14:00.000Z"
    }
  }
];

export function createMockSession(roles: AdminRole[] = ["administrator"]): AdminSession {
  return {
    ...mockSession,
    user: { ...mockSession.user },
    organization: { ...mockSession.organization },
    roles: [...roles],
    session: { ...mockSession.session }
  };
}

export function createMockCapabilityDescriptor(
  channel: Pick<Channel, "id" | "channel_type">,
  generatedAt = "2026-07-03T10:05:00.000Z"
): ChannelCapabilityDescriptor {
  const supported =
    channel.channel_type === "web_chat"
      ? new Set<ChannelCapabilityName>(["text", "image", "file", "typing_indicator", "read_receipt"])
      : new Set<ChannelCapabilityName>(["text", "image", "buttons", "read_receipt"]);

  return {
    contract: "C6.CapabilityDescriptor",
    version: "1.0.0",
    channel_type: channel.channel_type,
    channel_id: channel.id,
    adapter: {
      name: `${channel.channel_type}-adapter`,
      version: "0.0.0"
    },
    capabilities: Object.fromEntries(
      channelCapabilityNames.map((capability) => [
        capability,
        supported.has(capability)
          ? { supported: true }
          : { supported: false, notes: "Не поддерживается текущим адаптером." }
      ])
    ) as ChannelCapabilityDescriptor["capabilities"],
    generated_at: generatedAt
  };
}

// ── Workflow fixtures (C5, SVC-FBP) ────────────────────────────────────────
// Список Workflow, неизменяемые версии схемы (ТЗ §13.10) и инстансы исполнения
// для истории/диагностики. Схемы используют только безопасный набор узлов
// (ТЗ §13.13); данные изменяются исключительно узлом вызова Backend API.
export const mockWorkflows: Workflow[] = [
  {
    id: "wf-support-autoresponder",
    organization_id: "org-demo",
    name: "Автоответчик обращений",
    description: "Отвечает на типовые обращения и заводит тикет через Backend API.",
    status: "active",
    enabled: true,
    default_version_id: "wfv-support-2",
    created_at: "2026-07-02T12:00:00.000Z",
    updated_at: "2026-07-03T09:20:00.000Z"
  },
  {
    id: "wf-lead-qualifier",
    organization_id: "org-demo",
    name: "Квалификация лидов",
    description: "Черновой сценарий квалификации входящих лидов.",
    status: "draft",
    enabled: false,
    default_version_id: "wfv-lead-1",
    created_at: "2026-07-02T13:30:00.000Z",
    updated_at: "2026-07-02T13:30:00.000Z"
  }
];

export const mockWorkflowVersions: WorkflowVersion[] = [
  {
    id: "wfv-support-1",
    organization_id: "org-demo",
    workflow_id: "wf-support-autoresponder",
    version_no: 1,
    created_by: "Демо Администратор",
    created_at: "2026-07-02T12:00:00.000Z",
    schema: {
      nodes: [
        {
          id: "node-wait-event-1",
          type: "wait-event",
          label: "Входящее сообщение",
          config: { event_type: "channel.message_received" },
          position: { x: 40, y: 40 }
        },
        {
          id: "node-llm-1",
          type: "llm",
          label: "Черновик ответа",
          config: { prompt: "Ответь клиенту вежливо" },
          position: { x: 260, y: 40 }
        }
      ],
      connections: [{ id: "conn-1", from: "node-wait-event-1", fromPort: "out", to: "node-llm-1", toPort: "in" }]
    }
  },
  {
    id: "wfv-support-2",
    organization_id: "org-demo",
    workflow_id: "wf-support-autoresponder",
    version_no: 2,
    created_by: "Демо Администратор",
    created_at: "2026-07-03T09:20:00.000Z",
    schema: {
      nodes: [
        {
          id: "node-wait-event-1",
          type: "wait-event",
          label: "Входящее сообщение",
          config: { event_type: "channel.message_received" },
          position: { x: 40, y: 40 }
        },
        {
          id: "node-knowledge-base-search-1",
          type: "knowledge-base-search",
          label: "Поиск в базе знаний",
          config: { query: "{{message.text}}" },
          position: { x: 260, y: 40 }
        },
        {
          id: "node-llm-1",
          type: "llm",
          label: "Черновик ответа",
          config: { prompt: "Ответь клиенту на основе найденных материалов" },
          position: { x: 700, y: 40 }
        },
        {
          id: "node-transform-1",
          type: "transform",
          label: "Собрать тело ответа",
          config: { expression: "payload" },
          position: { x: 480, y: 40 }
        },
        {
          id: "node-backend-api-1",
          type: "backend-api",
          label: "Создать тикет",
          config: { path: "/api/v1/tickets" },
          position: { x: 700, y: 190 }
        }
      ],
      connections: [
        { id: "conn-1", from: "node-wait-event-1", fromPort: "out", to: "node-knowledge-base-search-1", toPort: "in" },
        { id: "conn-2", from: "node-knowledge-base-search-1", fromPort: "out", to: "node-transform-1", toPort: "in" },
        { id: "conn-3", from: "node-transform-1", fromPort: "out", to: "node-llm-1", toPort: "in" },
        { id: "conn-4", from: "node-llm-1", fromPort: "out", to: "node-backend-api-1", toPort: "in" }
      ]
    }
  },
  {
    id: "wfv-lead-1",
    organization_id: "org-demo",
    workflow_id: "wf-lead-qualifier",
    version_no: 1,
    created_by: "Демо Администратор",
    created_at: "2026-07-02T13:30:00.000Z",
    schema: {
      nodes: [
        {
          id: "node-wait-event-1",
          type: "wait-event",
          label: "Новый лид",
          config: { event_type: "channel.message_received" },
          position: { x: 40, y: 40 }
        },
        {
          id: "node-branch-1",
          type: "branch",
          label: "Оценка бюджета",
          config: { condition: "{{lead.budget}} > 1000" },
          position: { x: 260, y: 40 }
        },
        {
          id: "node-backend-api-1",
          type: "backend-api",
          label: "Создать сделку",
          config: { path: "/api/v1/deals" },
          position: { x: 480, y: 40 }
        }
      ],
      connections: [
        { id: "conn-1", from: "node-wait-event-1", fromPort: "out", to: "node-branch-1", toPort: "in" },
        { id: "conn-2", from: "node-branch-1", fromPort: "true", to: "node-backend-api-1", toPort: "in" }
      ]
    }
  }
];

export const mockWorkflowInstances: WorkflowInstance[] = [
  {
    id: "wfi-support-1001",
    organization_id: "org-demo",
    workflow_id: "wf-support-autoresponder",
    workflow_version_id: "wfv-support-2",
    version_no: 2,
    status: "completed",
    started_at: "2026-07-03T10:00:00.000Z",
    finished_at: "2026-07-03T10:00:04.000Z",
    created_at: "2026-07-03T10:00:00.000Z"
  },
  {
    id: "wfi-support-1002",
    organization_id: "org-demo",
    workflow_id: "wf-support-autoresponder",
    workflow_version_id: "wfv-support-1",
    version_no: 1,
    status: "degraded",
    started_at: "2026-07-03T09:30:00.000Z",
    finished_at: null,
    created_at: "2026-07-03T09:30:00.000Z"
  }
];

export const mockWorkflowInstanceLogs: Record<string, WorkflowInstanceLogEntry[]> = {
  "wfi-support-1001": [
    {
      id: "log-1001-1",
      node_id: "node-wait-event-1",
      node_type: "wait-event",
      event: "node.completed",
      message: "Получено сообщение от клиента.",
      created_at: "2026-07-03T10:00:00.500Z"
    },
    {
      id: "log-1001-2",
      node_id: "node-knowledge-base-search-1",
      node_type: "knowledge-base-search",
      event: "node.completed",
      message: "Найдено 2 фрагмента в базе знаний.",
      created_at: "2026-07-03T10:00:01.500Z"
    },
    {
      id: "log-1001-3",
      node_id: "node-llm-1",
      node_type: "llm",
      event: "node.completed",
      message: "LLM подготовил черновик ответа.",
      created_at: "2026-07-03T10:00:02.500Z"
    },
    {
      id: "log-1001-4",
      node_id: "node-backend-api-1",
      node_type: "backend-api",
      event: "node.completed",
      message: "Backend API создал тикет T-1001.",
      created_at: "2026-07-03T10:00:03.500Z"
    },
    {
      id: "log-1001-5",
      node_id: null,
      event: "instance.completed",
      message: "Инстанс успешно завершён.",
      created_at: "2026-07-03T10:00:04.000Z"
    }
  ],
  "wfi-support-1002": [
    {
      id: "log-1002-1",
      node_id: "node-wait-event-1",
      node_type: "wait-event",
      event: "node.completed",
      message: "Получено сообщение от клиента.",
      created_at: "2026-07-03T09:30:00.500Z"
    },
    {
      id: "log-1002-2",
      node_id: null,
      event: "instance.degraded",
      message: "SVC-AI недоступен — сработал фолбэк, ответ отправлен без AI.",
      created_at: "2026-07-03T09:30:01.000Z"
    }
  ]
};

export function cloneWorkflow(workflow: Workflow): Workflow {
  return { ...workflow };
}

export function cloneWorkflowSchema(schema: WorkflowSchema): WorkflowSchema {
  return {
    nodes: schema.nodes.map((node) => ({
      ...node,
      config: cloneWorkflowNodeConfig(node.config),
      position: { ...node.position }
    })),
    connections: schema.connections.map((connection) => ({ ...connection }))
  };
}

function cloneWorkflowNodeConfig(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [key, cloneWorkflowConfigValue(value)])
  );
}

function cloneWorkflowConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneWorkflowConfigValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        cloneWorkflowConfigValue(nested)
      ])
    );
  }

  return value;
}

export function cloneWorkflowVersion(version: WorkflowVersion): WorkflowVersion {
  return { ...version, schema: cloneWorkflowSchema(version.schema) };
}

export function cloneWorkflowInstance(instance: WorkflowInstance): WorkflowInstance {
  return { ...instance };
}

export function cloneWorkflowInstanceDetail(detail: WorkflowInstanceDetail): WorkflowInstanceDetail {
  return { ...detail, logs: detail.logs.map((entry) => ({ ...entry })) };
}

// ── Broadcast fixtures (C8, SVC-BCAST) ─────────────────────────────────────
// Кампании массовых коммуникаций для раздела Broadcast (CP-6). UI отображает
// список и статистику, но не выполняет доставку — рассылка идёт через ядро (C1/C2)
// на стороне SVC-BCAST (ТЗ §21.5).
export const mockBroadcasts: BroadcastCampaign[] = [
  {
    id: "broadcast-welcome",
    organization_id: "org-demo",
    name: "Приветственная серия",
    status: "done",
    template: {
      type: "text",
      body: "Здравствуйте, {{name}}! Спасибо, что подключились к нашему сервису.",
      locale: "ru",
      variables: ["name"]
    },
    filter: {
      mode: "all",
      channels: ["channel-web-chat-main"]
    },
    schedule: {
      mode: "immediate",
      timezone: "Europe/Moscow"
    },
    rate_limit: {
      messages_per_minute: 60,
      strategy: "fixed"
    },
    created_by: "Демо Администратор",
    created_at: "2026-07-01T09:00:00.000Z",
    updated_at: "2026-07-01T09:30:00.000Z"
  },
  {
    id: "broadcast-promo-july",
    organization_id: "org-demo",
    name: "Июльская акция",
    status: "scheduled",
    template: {
      type: "text",
      body: "Только до конца июля: скидка 20% по промокоду JULY.",
      locale: "ru",
      variables: []
    },
    filter: {
      mode: "tags",
      channels: ["channel-web-chat-main", "channel-telegram-main"],
      tags: ["vip", "active"]
    },
    schedule: {
      mode: "scheduled",
      scheduled_for: "2026-07-10T08:00:00.000Z",
      timezone: "Europe/Moscow"
    },
    rate_limit: {
      messages_per_minute: 120,
      burst: 50,
      strategy: "channel_capability"
    },
    created_by: "Демо Администратор",
    created_at: "2026-07-03T11:00:00.000Z",
    updated_at: "2026-07-03T11:05:00.000Z"
  }
];

export const mockBroadcastStats: Record<string, BroadcastStats> = {
  "broadcast-welcome": {
    prepared: 1200,
    sent: 1200,
    delivered: 1180,
    failed: 20,
    updated_at: "2026-07-01T09:30:00.000Z"
  },
  "broadcast-promo-july": {
    prepared: 340,
    sent: 0,
    delivered: 0,
    failed: 0,
    updated_at: "2026-07-03T11:05:00.000Z"
  }
};

export function cloneBroadcastTemplate(
  template: BroadcastCampaign["template"]
): BroadcastCampaign["template"] {
  return {
    ...template,
    variables: template.variables ? [...template.variables] : undefined
  };
}

export function cloneBroadcastFilter(
  filter: BroadcastCampaign["filter"]
): BroadcastCampaign["filter"] {
  return {
    ...filter,
    channels: filter.channels ? [...filter.channels] : undefined,
    tags: filter.tags ? [...filter.tags] : undefined,
    segment_ids: filter.segment_ids ? [...filter.segment_ids] : undefined,
    criteria: filter.criteria ? { ...filter.criteria } : undefined
  };
}

export function cloneBroadcast(campaign: BroadcastCampaign): BroadcastCampaign {
  return {
    ...campaign,
    template: cloneBroadcastTemplate(campaign.template),
    filter: cloneBroadcastFilter(campaign.filter),
    schedule: { ...campaign.schedule },
    rate_limit: { ...campaign.rate_limit }
  };
}

export function cloneBroadcastStats(stats: BroadcastStats): BroadcastStats {
  return { ...stats };
}

// ── Notification fixtures (C10, SVC-NOTIF) ─────────────────────────────────
// Лента уведомлений текущего пользователя и настройки категорий/каналов доставки
// (CP-8, ТЗ §15.4). UI не генерирует и не доставляет уведомления — только
// отображает их и вызывает фасад C10.
export const notificationCategories: NotificationCategory[] = [
  "info",
  "warning",
  "error",
  "critical",
  "admin"
];

export const notificationChannels: NotificationChannel[] = ["web", "telegram", "email", "push"];

export const mockNotifications: Notification[] = [
  {
    contract: "C10.Notification",
    version: "1.0.0",
    id: "notif-broadcast-welcome",
    organization_id: "org-demo",
    recipient_user_id: "00000000-0000-4000-8000-000000000101",
    category: "info",
    title: "Кампания «Приветственная серия» завершена",
    body: "Доставлено 1180 из 1200 сообщений.",
    payload: { broadcast_id: "broadcast-welcome" },
    status: "new",
    channels: ["web", "telegram"],
    created_at: "2026-07-01T09:30:00.000Z",
    read_at: null
  },
  {
    contract: "C10.Notification",
    version: "1.0.0",
    id: "notif-channel-telegram-error",
    organization_id: "org-demo",
    recipient_user_id: "00000000-0000-4000-8000-000000000101",
    category: "error",
    title: "Канал Telegram Support недоступен",
    body: "Webhook не ответил за 5 секунд. Проверьте настройки канала.",
    payload: { channel_id: "channel-telegram-main" },
    status: "new",
    channels: ["web"],
    created_at: "2026-07-03T09:55:00.000Z",
    read_at: null
  },
  {
    contract: "C10.Notification",
    version: "1.0.0",
    id: "notif-quota-warning",
    organization_id: "org-demo",
    recipient_user_id: "00000000-0000-4000-8000-000000000101",
    category: "warning",
    title: "Использовано 80% месячного лимита сообщений",
    body: "Осталось 2000 сообщений из 10000 в текущем месяце.",
    payload: {},
    status: "read",
    channels: ["web", "email"],
    created_at: "2026-07-02T18:00:00.000Z",
    read_at: "2026-07-02T18:05:00.000Z"
  }
];

export const mockNotificationSettings: NotificationSetting[] = notificationCategories.flatMap(
  (category) =>
    notificationChannels.map((channel) => ({
      category,
      channel,
      // Web включён для всех категорий; email — только для важных; telegram — для
      // ошибок и критических; push по умолчанию выключен.
      enabled:
        channel === "web" ||
        (channel === "email" && (category === "warning" || category === "critical")) ||
        (channel === "telegram" && (category === "error" || category === "critical"))
    }))
);

export function cloneNotification(notification: Notification): Notification {
  return {
    ...notification,
    payload: { ...notification.payload },
    channels: [...notification.channels]
  };
}

export function cloneNotificationSettings(settings: NotificationSetting[]): NotificationSetting[] {
  return settings.map((setting) => ({ ...setting }));
}

// ── Deterministic mock-AI onboarding (C4, SVC-AI) ──────────────────────────
// Детерминированный «AI» без сети и случайностей: по ключевым словам формирует
// структурированную команду (ТЗ §16.8). Команда — только описание намерения;
// применяет её Backend после проверки полномочий и схемы (ТЗ §12.5, §12.6).
export const ONBOARDING_CONFIG_LABEL = "organization.configuration";

const APPLY_NOTE = "Изменение применяется Backend после проверки прав администратора.";
const UNSUPPORTED_MESSAGE =
  "Эта операция появится в следующем релизе (M4). Backend отклонит применение как не поддерживаемое.";

export interface OnboardingContext {
  organizationId: string;
  organization: Organization;
  configuration: OrganizationConfiguration;
}

interface OnboardingPlan {
  action: OnboardingCommandAction;
  params: Record<string, unknown>;
  summary: string;
  assistantMessage: string;
  notes: string[];
}

const CONFIGURATION_KEYS: (keyof OrganizationConfiguration)[] = [
  "defaultLanguage",
  "aiAssistantEnabled",
  "workflowAutomationEnabled",
  "monthlyMessageLimit",
  "notificationEmail",
  "retentionDays"
];

const ORGANIZATION_KEYS: (keyof Organization)[] = [
  "name",
  "description",
  "timezone",
  "locale",
  "status"
];

export function deriveOnboardingCommand(
  request: OnboardingCommandRequest,
  context: OnboardingContext,
  options: { requestId: string; createdAt: string }
): OnboardingCommandResponse {
  const prompt = request.prompt.trim();
  const plan = planOnboarding(prompt, context);

  const command: OnboardingCommand = {
    contract: "C4.AiOnboardingCommand",
    version: "1.0.0",
    command_id: `${options.requestId}:command`,
    organization_id: context.organizationId,
    action: plan.action,
    params: plan.params,
    safety: {
      apply_mode: "backend_validation_required",
      requires_confirmation: true,
      notes: plan.notes
    },
    source: {
      prompt,
      generated_by: "generated"
    },
    created_at: options.createdAt
  };

  return {
    contract: "C4.OnboardingCommandResponse",
    version: "1.0.0",
    request_id: options.requestId,
    organization_id: context.organizationId,
    degraded: false,
    fallback_reason: null,
    summary: plan.summary,
    assistant_message: plan.assistantMessage,
    command
  };
}

export function applyOnboardingCommand(
  command: OnboardingCommand,
  context: OnboardingContext,
  options: { appliedAt: string; configurationVersion: number }
): { result: OnboardingApplyResult; organization: Organization; configuration: OrganizationConfiguration } {
  let organization = { ...context.organization };
  let configuration = { ...context.configuration };

  switch (command.action) {
    case "configuration.upsert": {
      const value = (command.params.value ?? {}) as Partial<OrganizationConfiguration>;
      const patch: Record<string, unknown> = {};
      for (const key of CONFIGURATION_KEYS) {
        if (Object.hasOwn(value, key)) {
          patch[key] = value[key];
        }
      }
      configuration = { ...configuration, ...patch, updatedAt: options.appliedAt };
      const key = typeof command.params.key === "string" ? command.params.key : ONBOARDING_CONFIG_LABEL;
      return {
        result: {
          action: command.action,
          applied: true,
          status: "applied",
          detail: { key, version: options.configurationVersion }
        },
        organization,
        configuration
      };
    }

    case "organization.update_profile": {
      const patch: Record<string, unknown> = {};
      for (const key of ORGANIZATION_KEYS) {
        if (Object.hasOwn(command.params, key)) {
          patch[key] = command.params[key];
        }
      }
      organization = { ...organization, ...patch, updatedAt: options.appliedAt };
      return {
        result: {
          action: command.action,
          applied: true,
          status: "applied",
          detail: { status: organization.status }
        },
        organization,
        configuration
      };
    }

    case "channel.connect":
    case "user.invite":
      return {
        result: {
          action: command.action,
          applied: false,
          status: "not_supported",
          detail: { reason: "action_not_supported_in_m3" }
        },
        organization,
        configuration
      };

    case "noop":
    default:
      return {
        result: { action: command.action, applied: false, status: "noop", detail: {} },
        organization,
        configuration
      };
  }
}

function planOnboarding(prompt: string, context: OnboardingContext): OnboardingPlan {
  const text = prompt.toLowerCase();
  const number = extractNumber(prompt);

  if (text.includes("лимит") && number !== null) {
    return {
      action: "configuration.upsert",
      params: { key: ONBOARDING_CONFIG_LABEL, value: { monthlyMessageLimit: number } },
      summary: `Обновить месячный лимит сообщений до ${number}.`,
      assistantMessage: `Подготовил команду: изменить месячный лимит сообщений с ${context.configuration.monthlyMessageLimit} до ${number}. Подтвердите применение.`,
      notes: [APPLY_NOTE]
    };
  }

  if (matchesToggle(text, ["ассистент", "assistant", "ии", "gpt"])) {
    const enabled = !isDisableIntent(text);
    return {
      action: "configuration.upsert",
      params: { key: ONBOARDING_CONFIG_LABEL, value: { aiAssistantEnabled: enabled } },
      summary: `${enabled ? "Включить" : "Отключить"} AI-ассистента.`,
      assistantMessage: `Подготовил команду: ${enabled ? "включить" : "отключить"} AI-ассистента. Подтвердите применение.`,
      notes: [APPLY_NOTE]
    };
  }

  if (matchesToggle(text, ["workflow", "автоматизац", "сценари"])) {
    const enabled = !isDisableIntent(text);
    return {
      action: "configuration.upsert",
      params: { key: ONBOARDING_CONFIG_LABEL, value: { workflowAutomationEnabled: enabled } },
      summary: `${enabled ? "Включить" : "Отключить"} автоматизацию Workflow.`,
      assistantMessage: `Подготовил команду: ${enabled ? "включить" : "отключить"} автоматизацию Workflow. Подтвердите применение.`,
      notes: [APPLY_NOTE]
    };
  }

  const newName = extractQuoted(prompt);
  if (newName && (text.includes("переимен") || text.includes("назван") || text.includes("имя организац"))) {
    return {
      action: "organization.update_profile",
      params: { name: newName },
      summary: `Переименовать организацию в «${newName}».`,
      assistantMessage: `Подготовил команду: изменить название организации на «${newName}». Подтвердите применение.`,
      notes: [APPLY_NOTE]
    };
  }

  if (text.includes("подключ") && (text.includes("канал") || text.includes("channel"))) {
    return {
      action: "channel.connect",
      params: { channel_type: "web_chat" },
      summary: "Подключить новый канал.",
      assistantMessage: UNSUPPORTED_MESSAGE,
      notes: ["Действие channel.connect ещё не поддерживается на этапе M3."]
    };
  }

  if (text.includes("пригласи") || text.includes("invite") || text.includes("пользовател")) {
    return {
      action: "user.invite",
      params: {},
      summary: "Пригласить пользователя.",
      assistantMessage: UNSUPPORTED_MESSAGE,
      notes: ["Действие user.invite ещё не поддерживается на этапе M3."]
    };
  }

  return {
    action: "noop",
    params: { reason: "no_actionable_intent" },
    summary: "Не удалось выделить конкретное действие.",
    assistantMessage:
      "Не удалось однозначно понять запрос. Уточните, что нужно изменить (например: «Подними месячный лимит до 50000»).",
    notes: ["Backend оставит конфигурацию без изменений."]
  };
}

function extractNumber(prompt: string): number | null {
  const match = prompt.match(/\d[\d\s]*/);
  if (!match) {
    return null;
  }

  const digits = match[0].replace(/\s+/g, "");
  if (!digits) {
    return null;
  }

  const value = Number.parseInt(digits, 10);
  return Number.isFinite(value) ? value : null;
}

function extractQuoted(prompt: string): string | null {
  const match = prompt.match(/[«"']\s*([^«»"']+?)\s*[»"']/);
  return match ? match[1].trim() : null;
}

function isDisableIntent(text: string): boolean {
  return (
    text.includes("выключ") ||
    text.includes("отключ") ||
    text.includes("disable") ||
    text.includes("убери") ||
    text.includes("не нужен") ||
    text.includes("не нужно")
  );
}

function matchesToggle(text: string, keywords: string[]): boolean {
  const hasKeyword = keywords.some((keyword) => text.includes(keyword));
  const hasIntent = text.includes("включ") || isDisableIntent(text);
  return hasKeyword && hasIntent;
}
