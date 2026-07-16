// СГЕНЕРИРОВАННЫЙ ФАЙЛ — не редактировать вручную.
// Источник: packages/contracts/openapi/backend-core/openapi.json
// Генератор: packages/contracts/scripts/generate-backend-api-catalog.mjs
// Обновить: npm run generate --workspace=@bridge/contracts
//
// Каталог операций Backend API, доступных узлу «Вызов Backend API». Витрину
// поверх каталога курирует platform_operator (таблица workflow_backend_api_allowlist):
// каталог отвечает на вопрос «что вообще существует», allowlist — «что разрешено
// дёргать из схемы».

/** Операция Backend API, которую может вызвать узел схемы. */
export interface BackendApiOperation {
  readonly operation_id: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly summary: string;
  readonly tag: string;
  /** Плейсхолдеры пути: каждому нужен одноимённый входной порт узла. */
  readonly path_params: readonly string[];
  readonly query_params: readonly string[];
  readonly has_body: boolean;
}

export const BACKEND_API_OPERATIONS: readonly BackendApiOperation[] = Object.freeze([
  {
    operation_id: "AiIntegrationController_completeLlm_v1",
    method: "POST",
    path: "/api/v1/ai/llm:complete",
    summary: "Run a raw LLM completion (degrades to a safe fallback)",
    tag: "ai-integration",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "AiIntegrationController_createOnboardingCommand_v1",
    method: "POST",
    path: "/api/v1/ai/onboarding:command",
    summary: "Generate a structured AI onboarding command (never auto-applied)",
    tag: "ai-integration",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "AiIntegrationController_suggestAssistant_v1",
    method: "POST",
    path: "/api/v1/ai/assistant:suggest",
    summary: "Request an AI assistant suggestion (degrades to a safe fallback)",
    tag: "ai-integration",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "AttachmentController_downloadContent_v1",
    method: "GET",
    path: "/api/v1/attachments/{id}/content",
    summary: "Download attachment bytes (proxied from Edge storage)",
    tag: "attachments",
    path_params: Object.freeze(["id"]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "AttachmentController_upload_v1",
    method: "POST",
    path: "/api/v1/attachments",
    summary: "Upload outgoing attachment bytes (proxied to Edge storage)",
    tag: "attachments",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "AuthSessionController_logout_v1",
    method: "POST",
    path: "/api/v1/auth/logout",
    summary: "Logout current server session",
    tag: "auth",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "BackendApiController_applyOnboarding_v1",
    method: "POST",
    path: "/api/v1/ai/onboarding:apply",
    summary: "Apply a confirmed AI onboarding command (actor_type = ai)",
    tag: "backend-api",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "BackendApiController_invokeNode_v1",
    method: "POST",
    path: "/api/v1/workflows/backend-api-node:invoke",
    summary: "Apply a change requested by a Workflow node (actor_type = workflow)",
    tag: "backend-api",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "BroadcastFacadeController_createBroadcast_v1",
    method: "POST",
    path: "/api/v1/broadcasts",
    summary: "Create a broadcast campaign through SVC-BCAST facade",
    tag: "broadcasts",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "BroadcastFacadeController_getBroadcastStats_v1",
    method: "GET",
    path: "/api/v1/broadcasts/{id}/stats",
    summary: "Read broadcast campaign stats through SVC-BCAST facade",
    tag: "broadcasts",
    path_params: Object.freeze(["id"]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "BroadcastFacadeController_listBroadcasts_v1",
    method: "GET",
    path: "/api/v1/broadcasts",
    summary: "List broadcasts through SVC-BCAST facade",
    tag: "broadcasts",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "BroadcastFacadeController_startBroadcast_v1",
    method: "POST",
    path: "/api/v1/broadcasts/{id}:start",
    summary: "Start a broadcast campaign through SVC-BCAST facade",
    tag: "broadcasts",
    path_params: Object.freeze(["id"]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "ChannelsController_connectChannel_v1",
    method: "POST",
    path: "/api/v1/channels",
    summary: "Connect an omnichannel adapter",
    tag: "channels",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "ChannelsController_deleteChannel_v1",
    method: "DELETE",
    path: "/api/v1/channels/{id}",
    summary: "Delete a channel and wipe its credentials",
    tag: "channels",
    path_params: Object.freeze(["id"]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "ChannelsController_getCapabilities_v1",
    method: "GET",
    path: "/api/v1/channels/{id}/capabilities",
    summary: "Return channel C6 capabilities",
    tag: "channels",
    path_params: Object.freeze(["id"]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "ChannelsController_listChannels_v1",
    method: "GET",
    path: "/api/v1/channels",
    summary: "List connected channels",
    tag: "channels",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "ChannelsController_updateChannel_v1",
    method: "PUT",
    path: "/api/v1/channels/{id}",
    summary: "Update a channel and rotate its credentials",
    tag: "channels",
    path_params: Object.freeze(["id"]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "ChannelTestController_testChannel_v1",
    method: "POST",
    path: "/api/v1/channels/{id}:test",
    summary: "Test a connected channel",
    tag: "channels",
    path_params: Object.freeze(["id"]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "ClientController_addEndpoint_v1",
    method: "POST",
    path: "/api/v1/clients/{id}/endpoints",
    summary: "Proxy client endpoint creation to Communication Core",
    tag: "clients",
    path_params: Object.freeze(["id"]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "ClientController_addNote_v1",
    method: "POST",
    path: "/api/v1/clients/{id}/notes",
    summary: "Create client note",
    tag: "clients",
    path_params: Object.freeze(["id"]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "ClientController_addTag_v1",
    method: "POST",
    path: "/api/v1/clients/{id}/tags",
    summary: "Create client tag",
    tag: "clients",
    path_params: Object.freeze(["id"]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "ClientController_createClient_v1",
    method: "POST",
    path: "/api/v1/clients",
    summary: "Create client in tenant scope",
    tag: "clients",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "ClientController_getClient_v1",
    method: "GET",
    path: "/api/v1/clients/{id}",
    summary: "Get client by id in tenant scope",
    tag: "clients",
    path_params: Object.freeze(["id"]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "ClientController_listClients_v1",
    method: "GET",
    path: "/api/v1/clients",
    summary: "List clients in tenant scope",
    tag: "clients",
    path_params: Object.freeze([]),
    query_params: Object.freeze(["cursor", "filter", "limit", "q"]),
    has_body: false,
  },
  {
    operation_id: "ClientMergeController_mergeClients_v1",
    method: "POST",
    path: "/api/v1/clients:merge",
    summary: "Proxy client merge to Communication Core",
    tag: "clients",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "ConfigurationController_getConfiguration_v1",
    method: "GET",
    path: "/api/v1/organizations/{organizationId}/configuration",
    summary: "Get organization configuration",
    tag: "configuration",
    path_params: Object.freeze(["organizationId"]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "ConfigurationController_putConfiguration_v1",
    method: "PUT",
    path: "/api/v1/organizations/{organizationId}/configuration",
    summary: "Replace organization configuration and record history",
    tag: "configuration",
    path_params: Object.freeze(["organizationId"]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "ConversationController_getConversation_v1",
    method: "GET",
    path: "/api/v1/conversations/{id}",
    summary: "Proxy conversation by id from Communication Core",
    tag: "conversations",
    path_params: Object.freeze(["id"]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "ConversationController_listConversations_v1",
    method: "GET",
    path: "/api/v1/conversations",
    summary: "Proxy conversation list from Communication Core",
    tag: "conversations",
    path_params: Object.freeze([]),
    query_params: Object.freeze(["cursor", "filter", "limit", "q"]),
    has_body: false,
  },
  {
    operation_id: "ConversationController_listMessages_v1",
    method: "GET",
    path: "/api/v1/conversations/{id}/messages",
    summary: "Proxy conversation messages from Communication Core",
    tag: "conversations",
    path_params: Object.freeze(["id"]),
    query_params: Object.freeze(["cursor", "filter", "limit", "q"]),
    has_body: false,
  },
  {
    operation_id: "FbpIntegrationController_startWorkflow_v1",
    method: "POST",
    path: "/api/v1/fbp/workflows/{workflowId}:start",
    summary: "Start a Workflow instance (initiated by the Backend, degrades safely)",
    tag: "fbp-integration",
    path_params: Object.freeze(["workflowId"]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "HealthController_getHealth_v1",
    method: "GET",
    path: "/api/v1/health",
    summary: "Backend health check",
    tag: "health",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "HealthController_getMetrics_v1",
    method: "GET",
    path: "/api/v1/metrics",
    summary: "Backend metrics skeleton",
    tag: "health",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "InvitationsController_acceptInvitation_v1",
    method: "POST",
    path: "/api/v1/invitations/accept",
    summary: "Accept a one-time invitation token and create first session",
    tag: "invitations",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "InvitationsController_createInvitation_v1",
    method: "POST",
    path: "/api/v1/invitations",
    summary: "Create an organization user invitation",
    tag: "invitations",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "KnowledgeBaseController_createDocument_v1",
    method: "POST",
    path: "/api/v1/knowledge/documents",
    summary: "Create a Knowledge Base document and embed its content",
    tag: "knowledge",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "KnowledgeBaseController_deleteDocument_v1",
    method: "DELETE",
    path: "/api/v1/knowledge/documents/{id}",
    summary: "Delete a Knowledge Base document",
    tag: "knowledge",
    path_params: Object.freeze(["id"]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "KnowledgeBaseController_listDocuments_v1",
    method: "GET",
    path: "/api/v1/knowledge/documents",
    summary: "List Knowledge Base documents in tenant scope",
    tag: "knowledge",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "KnowledgeBaseController_updateDocument_v1",
    method: "PATCH",
    path: "/api/v1/knowledge/documents/{id}",
    summary: "Update a Knowledge Base document",
    tag: "knowledge",
    path_params: Object.freeze(["id"]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "KnowledgeSearchController_searchDocuments_v1",
    method: "POST",
    path: "/api/v1/knowledge/documents:search",
    summary: "Search Knowledge Base documents by key phrases and tags",
    tag: "knowledge",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "MailController_orderMailbox_v1",
    method: "POST",
    path: "/api/v1/mail/mailboxes",
    summary: "Order a managed Bridge Mail mailbox and connect it as an email channel",
    tag: "mail",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "MessageController_createMessage_v1",
    method: "POST",
    path: "/api/v1/messages",
    summary: "Idempotently proxy outbound message creation to Communication Core",
    tag: "messages",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "MessageController_getMessage_v1",
    method: "GET",
    path: "/api/v1/messages/{id}",
    summary: "Proxy message by id from Communication Core",
    tag: "messages",
    path_params: Object.freeze(["id"]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "NotificationFacadeController_getNotificationSettings_v1",
    method: "GET",
    path: "/api/v1/notifications/settings",
    summary: "Read current-user notification settings through SVC-NOTIF facade",
    tag: "notifications",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "NotificationFacadeController_listNotifications_v1",
    method: "GET",
    path: "/api/v1/notifications",
    summary: "List current-user notifications through SVC-NOTIF facade",
    tag: "notifications",
    path_params: Object.freeze([]),
    query_params: Object.freeze(["category", "cursor", "limit", "status"]),
    has_body: false,
  },
  {
    operation_id: "NotificationFacadeController_markNotificationRead_v1",
    method: "POST",
    path: "/api/v1/notifications/{id}:read",
    summary: "Mark a current-user notification read through SVC-NOTIF facade",
    tag: "notifications",
    path_params: Object.freeze(["id"]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "NotificationFacadeController_updateNotificationSettings_v1",
    method: "PUT",
    path: "/api/v1/notifications/settings",
    summary: "Update current-user notification settings through SVC-NOTIF facade",
    tag: "notifications",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "OrganizationController_getOrganization_v1",
    method: "GET",
    path: "/api/v1/organizations/{id}",
    summary: "Get organization by id",
    tag: "organizations",
    path_params: Object.freeze(["id"]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "OrganizationController_updateOrganization_v1",
    method: "PATCH",
    path: "/api/v1/organizations/{id}",
    summary: "Update organization settings",
    tag: "organizations",
    path_params: Object.freeze(["id"]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "OrganizationUsersController_createUser_v1",
    method: "POST",
    path: "/api/v1/organizations/{organizationId}/users",
    summary: "Create organization user",
    tag: "users",
    path_params: Object.freeze(["organizationId"]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "OrganizationUsersController_listUsers_v1",
    method: "GET",
    path: "/api/v1/organizations/{organizationId}/users",
    summary: "List organization users",
    tag: "users",
    path_params: Object.freeze(["organizationId"]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "PlatformOrganizationsController_blockOrganization_v1",
    method: "POST",
    path: "/api/v1/platform/organizations/{id}/block",
    summary: "Block an organization tenant",
    tag: "platform",
    path_params: Object.freeze(["id"]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "PlatformOrganizationsController_createFirstAdministratorInvitation_v1",
    method: "POST",
    path: "/api/v1/platform/organizations/{id}/administrators",
    summary: "Create first Administrator invitation",
    tag: "platform",
    path_params: Object.freeze(["id"]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "PlatformOrganizationsController_provisionOrganization_v1",
    method: "POST",
    path: "/api/v1/platform/organizations",
    summary: "Provision an organization tenant",
    tag: "platform",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "RegistrationController_getStatus_v1",
    method: "GET",
    path: "/api/v1/auth/register/status/{requestId}",
    summary: "Poll a registration request until the Telegram code is delivered",
    tag: "auth",
    path_params: Object.freeze(["requestId"]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "RegistrationController_startRegistration_v1",
    method: "POST",
    path: "/api/v1/auth/register/start",
    summary: "Start a self-service organization registration and return the bot deep link",
    tag: "auth",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "RegistrationController_verifyRegistration_v1",
    method: "POST",
    path: "/api/v1/auth/register/verify",
    summary: "Verify the registration code, create the organization and sign the administrator in",
    tag: "auth",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "TelegramAuthController_getSession_v1",
    method: "GET",
    path: "/api/v1/auth/session",
    summary: "Return the current authenticated session",
    tag: "auth",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "TelegramAuthController_startTelegramLogin_v1",
    method: "POST",
    path: "/api/v1/auth/login/telegram/start",
    summary: "Start a Telegram login and deliver a one-time code",
    tag: "auth",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "TelegramAuthController_verifyTelegramLogin_v1",
    method: "POST",
    path: "/api/v1/auth/login/telegram/verify",
    summary: "Verify a Telegram login code and create a session",
    tag: "auth",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "UserController_listUserSessions_v1",
    method: "GET",
    path: "/api/v1/users/{id}/sessions",
    summary: "List active sessions for a user in tenant scope",
    tag: "users",
    path_params: Object.freeze(["id"]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "UserController_patchUser_v1",
    method: "PATCH",
    path: "/api/v1/users/{id}",
    summary: "Patch user in tenant scope",
    tag: "users",
    path_params: Object.freeze(["id"]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "UserController_revokeUserSessions_v1",
    method: "POST",
    path: "/api/v1/users/{id}/sessions:revoke",
    summary: "Revoke active sessions for a user in tenant scope",
    tag: "users",
    path_params: Object.freeze(["id"]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "WebChatController_createOrResumeSession_v1",
    method: "POST",
    path: "/api/v1/web-chat/sessions",
    summary: "Create or resume anonymous Web Chat session",
    tag: "web-chat",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "WebChatController_listMessages_v1",
    method: "GET",
    path: "/api/v1/web-chat/conversations/{id}/messages",
    summary: "List messages visible to a Web Chat visitor session",
    tag: "web-chat",
    path_params: Object.freeze(["id"]),
    query_params: Object.freeze(["after_sequence_number", "cursor", "limit", "organization_id", "visitor_session_id"]),
    has_body: false,
  },
  {
    operation_id: "WebChatController_sendMessage_v1",
    method: "POST",
    path: "/api/v1/web-chat/messages",
    summary: "Send an inbound Web Chat visitor message",
    tag: "web-chat",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "WebChatController_startEmailCode_v1",
    method: "POST",
    path: "/api/v1/web-chat/email-code",
    summary: "Start optional Web Chat email verification by code (не в MVP-UI виджета)",
    tag: "web-chat",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "WebChatController_verifyEmailCode_v1",
    method: "POST",
    path: "/api/v1/web-chat/email-code:verify",
    summary: "Verify optional Web Chat email code",
    tag: "web-chat",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "WorkflowBackendApiAllowlistController_listOperations_v1",
    method: "GET",
    path: "/api/v1/workflow-backend-api-allowlist",
    summary: "List Backend API operations available to Workflow nodes",
    tag: "workflow-backend-api-allowlist",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "WorkflowBackendApiAllowlistController_updateOperation_v1",
    method: "PATCH",
    path: "/api/v1/workflow-backend-api-allowlist/{operationId}",
    summary: "Allow or forbid a Backend API operation for Workflow nodes",
    tag: "workflow-backend-api-allowlist",
    path_params: Object.freeze(["operationId"]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "WorkflowController_createVersion_v1",
    method: "POST",
    path: "/api/v1/workflows/{workflowId}/versions",
    summary: "Create an immutable Workflow version",
    tag: "workflows",
    path_params: Object.freeze(["workflowId"]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "WorkflowController_exportWorkflow_v1",
    method: "GET",
    path: "/api/v1/workflows/{workflowId}/export",
    summary: "Export the active Workflow schema as JSON",
    tag: "workflows",
    path_params: Object.freeze(["workflowId"]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "WorkflowController_getDraft_v1",
    method: "GET",
    path: "/api/v1/workflows/{workflowId}/draft",
    summary: "Read persisted Workflow draft schema",
    tag: "workflows",
    path_params: Object.freeze(["workflowId"]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "WorkflowController_getInstance_v1",
    method: "GET",
    path: "/api/v1/workflows/{workflowId}/instances/{instanceId}",
    summary: "Read Workflow execution instance details",
    tag: "workflows",
    path_params: Object.freeze(["workflowId", "instanceId"]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "WorkflowController_importWorkflow_v1",
    method: "POST",
    path: "/api/v1/workflows/{workflowId}/import",
    summary: "Import a Workflow schema JSON into draft or immutable version",
    tag: "workflows",
    path_params: Object.freeze(["workflowId"]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "WorkflowController_listInstances_v1",
    method: "GET",
    path: "/api/v1/workflows/{workflowId}/instances",
    summary: "List Workflow execution instances",
    tag: "workflows",
    path_params: Object.freeze(["workflowId"]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "WorkflowController_listVersions_v1",
    method: "GET",
    path: "/api/v1/workflows/{workflowId}/versions",
    summary: "List immutable Workflow versions",
    tag: "workflows",
    path_params: Object.freeze(["workflowId"]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "WorkflowController_listWorkflows_v1",
    method: "GET",
    path: "/api/v1/workflows",
    summary: "List tenant Workflow definitions",
    tag: "workflows",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "WorkflowController_promoteDraft_v1",
    method: "POST",
    path: "/api/v1/workflows/{workflowId}/draft:promote",
    summary: "Promote Workflow draft to a new active immutable version",
    tag: "workflows",
    path_params: Object.freeze(["workflowId"]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "WorkflowController_resetDraft_v1",
    method: "DELETE",
    path: "/api/v1/workflows/{workflowId}/draft",
    summary: "Reset Workflow draft to the latest published schema",
    tag: "workflows",
    path_params: Object.freeze(["workflowId"]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "WorkflowController_saveDraft_v1",
    method: "PATCH",
    path: "/api/v1/workflows/{workflowId}/draft",
    summary: "Persist Workflow draft schema",
    tag: "workflows",
    path_params: Object.freeze(["workflowId"]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "WorkflowController_testDraft_v1",
    method: "POST",
    path: "/api/v1/workflows/{workflowId}/draft:test",
    summary: "Test-run the Workflow draft without creating an instance",
    tag: "workflows",
    path_params: Object.freeze(["workflowId"]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "WorkflowController_updateWorkflow_v1",
    method: "PATCH",
    path: "/api/v1/workflows/{workflowId}",
    summary: "Update Workflow status/default version",
    tag: "workflows",
    path_params: Object.freeze(["workflowId"]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "WorkflowSubschemaController_createSubschema_v1",
    method: "POST",
    path: "/api/v1/workflow-subschemas",
    summary: "Create a reusable Workflow subschema",
    tag: "workflow-subschemas",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: true,
  },
  {
    operation_id: "WorkflowSubschemaController_listSubschemas_v1",
    method: "GET",
    path: "/api/v1/workflow-subschemas",
    summary: "List reusable Workflow subschemas",
    tag: "workflow-subschemas",
    path_params: Object.freeze([]),
    query_params: Object.freeze([]),
    has_body: false,
  },
  {
    operation_id: "WorkflowSubschemaController_updateSubschema_v1",
    method: "PATCH",
    path: "/api/v1/workflow-subschemas/{subschemaId}",
    summary: "Update a reusable Workflow subschema",
    tag: "workflow-subschemas",
    path_params: Object.freeze(["subschemaId"]),
    query_params: Object.freeze([]),
    has_body: true,
  },
] as const);

const BY_ID = new Map<string, BackendApiOperation>(
  BACKEND_API_OPERATIONS.map((operation) => [operation.operation_id, operation]),
);

export function getBackendApiOperation(operationId: string): BackendApiOperation | null {
  return BY_ID.get(operationId) ?? null;
}

export function isBackendApiOperationId(value: unknown): boolean {
  return typeof value === "string" && BY_ID.has(value);
}

/** Маршрут без плейсхолдеров — совпадение по точному ключу "METHOD /path". */
const BY_ROUTE = new Map<string, BackendApiOperation>(
  BACKEND_API_OPERATIONS.filter((operation) => operation.path_params.length === 0).map(
    (operation) => [`${operation.method} ${operation.path}`, operation],
  ),
);

interface TemplateRoute {
  readonly operation: BackendApiOperation;
  readonly segments: readonly string[];
}

/**
 * Шаблонные маршруты, отсортированные так, чтобы статический сегмент побеждал
 * плейсхолдер левее по пути. Без порядка запрос вида `/api/v1/a/b` мог бы
 * разрешиться то в `/api/v1/a/{id}`, то в `/api/v1/{x}/b` в зависимости от порядка
 * операций в OpenAPI — а от того, во что он разрешится, зависит проверка витрины.
 */
const TEMPLATE_ROUTES: readonly TemplateRoute[] = BACKEND_API_OPERATIONS.filter(
  (operation) => operation.path_params.length > 0,
)
  .map((operation) => ({ operation, segments: splitPathSegments(operation.path) }))
  .sort((left, right) => {
    const length = Math.min(left.segments.length, right.segments.length);
    for (let index = 0; index < length; index += 1) {
      const leftDynamic = isPlaceholderSegment(left.segments[index]);
      const rightDynamic = isPlaceholderSegment(right.segments[index]);
      if (leftDynamic !== rightDynamic) return leftDynamic ? 1 : -1;
    }
    return left.operation.path.localeCompare(right.operation.path);
  });

function splitPathSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}

function isPlaceholderSegment(segment: string): boolean {
  return segment.startsWith("{") && segment.endsWith("}");
}

/**
 * Обратный резолв конкретного запроса в операцию каталога: `GET /api/v1/clients/42`
 * → `ClientController_get_v1`. Нужен там, где на входе уже готовый HTTP-запрос, а
 * решение принимается по `operation_id` — например, когда витрина
 * `workflow_backend_api_allowlist` проверяется в рантайме, а не при сохранении схемы.
 *
 * Маршрут, которого нет в каталоге, возвращает `null`: вызывающая сторона обязана
 * трактовать это как запрет, а не как «проверить нечего».
 */
export function resolveBackendApiOperation(
  method: string,
  path: string,
): BackendApiOperation | null {
  const normalizedMethod = String(method ?? "").toUpperCase();
  // Query и фрагмент к выбору маршрута отношения не имеют; хвостовой слэш — тоже.
  const normalizedPath = String(path ?? "")
    .split("?")[0]
    .split("#")[0]
    .replace(/\/+$/, "");

  if (normalizedPath === "") return null;

  const exact = BY_ROUTE.get(`${normalizedMethod} ${normalizedPath}`);
  if (exact) return exact;

  const requestSegments = splitPathSegments(normalizedPath);

  for (const route of TEMPLATE_ROUTES) {
    if (route.operation.method !== normalizedMethod) continue;
    if (route.segments.length !== requestSegments.length) continue;

    const matches = route.segments.every((segment, index) => {
      const requested = requestSegments[index];
      // Плейсхолдер принимает любой НЕПУСТОЙ сегмент: пустой означал бы, что
      // параметр не подставлен, а такой запрос до API всё равно не дойдёт.
      return isPlaceholderSegment(segment) ? requested !== "" : segment === requested;
    });

    if (matches) return route.operation;
  }

  return null;
}
