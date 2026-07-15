import {
  DEMO_ORGANIZATION_SEED,
  M0_SEED_TIMESTAMP,
  SEEDED_ADMIN_USER_SEED,
} from "../../../packages/testing/src/db/m0-seed-data.js";

/**
 * Сидовые Workflow демо-организации — витрина возможностей 2.0 для оператора
 * (Ревизия 2026-07-15, решение A4). Workflow заводятся только сидом (R1), поэтому
 * это единственные схемы, которые оператор увидит в редакторе: они обязаны
 * исполняться, а не просто проходить валидацию.
 *
 * Что изменилось против 1.0 и почему:
 *
 *  - `entry` упразднён: точка входа — узел «Ожидание события». Обе схемы стартуют
 *    от `message.created` — это единственное событие реестра, несущее сообщение
 *    клиента. Прежние `channel.message_received` и `lead.created` в реестре
 *    отсутствуют (их никто не публикует), поэтому подписка на них никогда бы не
 *    сработала — молча и без следов.
 *  - `expression` и «проводка» `input: { kind: "node" }` заменены портами и
 *    data-связями; преобразования — обычный JS в `transform`.
 *  - Узлы `llm` и `knowledge-base-search` СОЗНАТЕЛЬНО не используются: их
 *    умолчательные пути (`/api/v1/ai/llm/completions`, `/api/v1/ai/knowledge-base/search`)
 *    в Backend не существуют — витрина 404-ила бы при первом же запуске. Черновик
 *    ответа готовит реальный каталожный вызов `assistant:suggest` (он же RAG по
 *    базе знаний).
 *  - `method`/`path` у `backend-api` заменены на `operation_id` из каталога
 *    (решение A3). Все используемые операции обязаны быть открыты в витрине —
 *    см. `SEEDED_WORKFLOW_BACKEND_API_ALLOWLIST`.
 */

/** Событие-источник: единственный тип реестра, несущий сообщение клиента. */
const MESSAGE_CREATED_EVENT = "message.created";

/**
 * Вызовы Backend API, которые используют сидовые схемы. Витрина закрыта по
 * умолчанию (`workflow_backend_api_allowlist.enabled = false`), поэтому без явного
 * открытия оператор не смог бы пересохранить сидовую схему из редактора: она
 * прошла бы контракт, но упала бы на проверке витрины. Открываем РОВНО эти три
 * операции, а не каталог целиком — «закрыто по умолчанию» остаётся в силе.
 *
 * `curated_by` намеренно NULL: витрину курирует человек, и приписывать решение
 * сидовому админу, который его не принимал, нельзя.
 */
export const SEEDED_WORKFLOW_BACKEND_API_ALLOWLIST = Object.freeze([
  {
    operation_id: "AiIntegrationController_suggestAssistant_v1",
    note: "Открыто сидом: черновик ответа в схеме «Автоответчик обращений».",
  },
  {
    operation_id: "MessageController_createMessage_v1",
    note: "Открыто сидом: отправка ответа клиенту в схеме «Автоответчик обращений».",
  },
  {
    operation_id: "ClientController_addTag_v1",
    note: "Открыто сидом: пометка клиента в схеме «Квалификация лидов».",
  },
]);

export const SEEDED_WORKFLOW_DEFINITIONS = Object.freeze([
  {
    id: "00000000-0000-4000-8000-000000000801",
    organization_id: DEMO_ORGANIZATION_SEED.id,
    name: "Автоответчик обращений",
    status: "active",
    default_version_id: "00000000-0000-4000-8000-000000000811",
    created_at: M0_SEED_TIMESTAMP,
    updated_at: M0_SEED_TIMESTAMP,
    versions: [
      {
        id: "00000000-0000-4000-8000-000000000811",
        version_no: 1,
        created_by: SEEDED_ADMIN_USER_SEED.id,
        created_at: M0_SEED_TIMESTAMP,
        /**
         * Пришло сообщение → отвечаем только на входящие → AI готовит черновик по
         * базе знаний → отправляем ответ клиенту.
         */
        schema: {
          schema_version: "2.0.0",
          kind: "workflow",
          nodes: [
            {
              id: "node-event-message",
              type: "wait-event",
              label: "Получено сообщение",
              config: { event_type: MESSAGE_CREATED_EVENT, correlation: {} },
              position: { x: 40, y: 160 },
            },
            {
              id: "node-parse-message",
              type: "transform",
              label: "Разобрать сообщение",
              config: {
                code: [
                  "const message = input.event.message ?? {};",
                  'const text = String(message.text ?? "");',
                  "return {",
                  "  text,",
                  "  direction: message.direction,",
                  "  conversationId: message.conversationId,",
                  "  suggestRequest: { query: text },",
                  "};",
                ].join("\n"),
                inputs: [{ name: "event", type: "object" }],
                outputs: [
                  { name: "text", type: "string", path: "result.text" },
                  { name: "direction", type: "string", path: "result.direction" },
                  { name: "conversationId", type: "string", path: "result.conversationId" },
                  { name: "suggestRequest", type: "object", path: "result.suggestRequest" },
                ],
              },
              position: { x: 280, y: 320 },
            },
            {
              // Исходящие сообщения пишем мы сами — отвечать на них значило бы
              // зациклить автоответчик на собственных ответах.
              id: "node-only-inbound",
              type: "branch",
              label: "Только входящие",
              config: { operator: "equals", right: "inbound" },
              position: { x: 520, y: 160 },
            },
            {
              id: "node-suggest-reply",
              type: "backend-api",
              label: "Черновик ответа (AI)",
              config: {
                operation_id: "AiIntegrationController_suggestAssistant_v1",
                inputs: [{ name: "body", type: "object" }],
                outputs: [{ name: "suggestion", type: "object" }],
              },
              position: { x: 760, y: 80 },
            },
            {
              id: "node-compose-reply",
              type: "transform",
              label: "Собрать ответ",
              config: {
                code: [
                  "return {",
                  "  conversationId: input.conversationId,",
                  '  direction: "outbound",',
                  '  senderType: "ai",',
                  "  content: { text: input.suggestion.text },",
                  "};",
                ].join("\n"),
                inputs: [
                  { name: "conversationId", type: "string" },
                  { name: "suggestion", type: "object" },
                ],
                outputs: [{ name: "body", type: "object", path: "result" }],
              },
              position: { x: 1000, y: 320 },
            },
            {
              id: "node-send-reply",
              type: "backend-api",
              label: "Отправить ответ",
              config: {
                operation_id: "MessageController_createMessage_v1",
                inputs: [{ name: "body", type: "object" }],
                outputs: [{ name: "id", type: "string" }],
              },
              position: { x: 1240, y: 80 },
            },
            {
              id: "node-mark-skipped",
              type: "variable_write",
              label: "Отметить пропуск",
              config: { inputs: [{ name: "skipped_direction", type: "string" }] },
              position: { x: 760, y: 280 },
            },
          ],
          connections: [
            { id: "conn-exec-event-branch", from: "node-event-message", fromPort: "out", to: "node-only-inbound", toPort: "in" },
            { id: "conn-exec-branch-suggest", from: "node-only-inbound", fromPort: "true", to: "node-suggest-reply", toPort: "in" },
            { id: "conn-exec-suggest-send", from: "node-suggest-reply", fromPort: "out", to: "node-send-reply", toPort: "in" },
            { id: "conn-exec-branch-skip", from: "node-only-inbound", fromPort: "false", to: "node-mark-skipped", toPort: "in" },
            { id: "conn-data-event-parse", from: "node-event-message", fromPort: "data", to: "node-parse-message", toPort: "event" },
            { id: "conn-data-direction-branch", from: "node-parse-message", fromPort: "direction", to: "node-only-inbound", toPort: "value" },
            { id: "conn-data-parse-suggest", from: "node-parse-message", fromPort: "suggestRequest", to: "node-suggest-reply", toPort: "body" },
            { id: "conn-data-parse-compose", from: "node-parse-message", fromPort: "conversationId", to: "node-compose-reply", toPort: "conversationId" },
            { id: "conn-data-suggest-compose", from: "node-suggest-reply", fromPort: "suggestion", to: "node-compose-reply", toPort: "suggestion" },
            { id: "conn-data-compose-send", from: "node-compose-reply", fromPort: "body", to: "node-send-reply", toPort: "body" },
            { id: "conn-data-direction-skip", from: "node-parse-message", fromPort: "direction", to: "node-mark-skipped", toPort: "skipped_direction" },
          ],
        },
      },
    ],
  },
  {
    id: "00000000-0000-4000-8000-000000000802",
    organization_id: DEMO_ORGANIZATION_SEED.id,
    name: "Квалификация лидов",
    status: "draft",
    default_version_id: "00000000-0000-4000-8000-000000000812",
    created_at: M0_SEED_TIMESTAMP,
    updated_at: M0_SEED_TIMESTAMP,
    versions: [
      {
        id: "00000000-0000-4000-8000-000000000812",
        version_no: 1,
        created_by: SEEDED_ADMIN_USER_SEED.id,
        created_at: M0_SEED_TIMESTAMP,
        /**
         * Пришло сообщение → считаем признаки покупательского намерения → при
         * двух и более помечаем клиента тегом, иначе запоминаем счёт.
         *
         * Показывает подстановку плейсхолдера пути: операция каталога
         * `POST /api/v1/clients/{id}/tags` требует одноимённый входной порт `id`.
         */
        schema: {
          schema_version: "2.0.0",
          kind: "workflow",
          nodes: [
            {
              id: "node-event-message",
              type: "wait-event",
              label: "Получено сообщение",
              config: { event_type: MESSAGE_CREATED_EVENT, correlation: {} },
              position: { x: 40, y: 160 },
            },
            {
              id: "node-score-lead",
              type: "transform",
              label: "Оценить намерение",
              config: {
                code: [
                  "const message = input.event.message ?? {};",
                  'const text = String(message.text ?? "").toLowerCase();',
                  'const signals = ["цена", "стоимость", "купить", "тариф", "оплата"];',
                  "const score = signals.filter((word) => text.includes(word)).length;",
                  "return { clientId: message.clientId, score };",
                ].join("\n"),
                inputs: [{ name: "event", type: "object" }],
                outputs: [
                  { name: "clientId", type: "string", path: "result.clientId" },
                  { name: "score", type: "number", path: "result.score" },
                ],
              },
              position: { x: 280, y: 320 },
            },
            {
              id: "node-check-intent",
              type: "branch",
              label: "Есть намерение купить",
              config: { operator: "gte", right: 2 },
              position: { x: 520, y: 160 },
            },
            {
              id: "node-tag-body",
              type: "transform",
              label: "Тег «квалифицированный лид»",
              config: {
                code: 'return { tag: "qualified-lead" };',
                outputs: [{ name: "body", type: "object", path: "result" }],
              },
              position: { x: 760, y: 320 },
            },
            {
              id: "node-tag-client",
              type: "backend-api",
              label: "Пометить клиента",
              config: {
                operation_id: "ClientController_addTag_v1",
                inputs: [
                  { name: "id", type: "string" },
                  { name: "body", type: "object" },
                ],
              },
              position: { x: 1000, y: 80 },
            },
            {
              id: "node-mark-cold",
              type: "variable_write",
              label: "Запомнить холодный лид",
              config: { inputs: [{ name: "cold_lead_score", type: "number" }] },
              position: { x: 760, y: 40 },
            },
          ],
          connections: [
            { id: "conn-exec-event-branch", from: "node-event-message", fromPort: "out", to: "node-check-intent", toPort: "in" },
            { id: "conn-exec-branch-tag", from: "node-check-intent", fromPort: "true", to: "node-tag-client", toPort: "in" },
            { id: "conn-exec-branch-cold", from: "node-check-intent", fromPort: "false", to: "node-mark-cold", toPort: "in" },
            { id: "conn-data-event-score", from: "node-event-message", fromPort: "data", to: "node-score-lead", toPort: "event" },
            { id: "conn-data-score-branch", from: "node-score-lead", fromPort: "score", to: "node-check-intent", toPort: "value" },
            { id: "conn-data-score-tag", from: "node-score-lead", fromPort: "clientId", to: "node-tag-client", toPort: "id" },
            { id: "conn-data-tagbody-tag", from: "node-tag-body", fromPort: "body", to: "node-tag-client", toPort: "body" },
            { id: "conn-data-score-cold", from: "node-score-lead", fromPort: "score", to: "node-mark-cold", toPort: "cold_lead_score" },
          ],
        },
      },
    ],
  },
]);
