export type ISODateTime = string;

export type AdminRole = "platform_operator" | "administrator" | "manager";

export interface AdminSession {
  authenticated: boolean;
  user: {
    id: string;
    organizationId: string;
    displayName: string;
    telegramUsername: string;
    status: "active" | "blocked";
  };
  organization: {
    id: string;
    slug: string;
    name: string;
  };
  roles: AdminRole[];
  session: {
    id: string;
    mode: string;
    issuedAt: ISODateTime;
    expiresAt: ISODateTime | null;
  };
  implementationStage?: string;
}

export interface TelegramLoginStartRequest {
  telegramUsername: string;
}

export interface TelegramLoginStartResponse {
  status: string;
  deliveryChannel: "telegram";
  telegramUsername: string;
  expiresInSeconds: number;
  implementationStage?: string;
  note?: string;
}

export interface TelegramLoginVerifyRequest {
  telegramUsername: string;
  code: string;
}

export interface LogoutResponse {
  loggedOut: true;
  sessionMode: string;
  implementationStage?: string;
  note?: string;
}

export interface Organization {
  id: string;
  name: string;
  description: string;
  timezone: string;
  locale: string;
  status: "active" | "blocked";
  updatedAt: ISODateTime;
}

export interface UpdateOrganizationRequest {
  name: string;
  description: string;
  timezone: string;
  locale: string;
}

export interface OrganizationConfiguration {
  organizationId: string;
  defaultLanguage: string;
  aiAssistantEnabled: boolean;
  workflowAutomationEnabled: boolean;
  monthlyMessageLimit: number;
  notificationEmail: string;
  retentionDays: number;
  updatedAt: ISODateTime;
}

export interface UpdateOrganizationConfigurationRequest {
  defaultLanguage: string;
  aiAssistantEnabled: boolean;
  workflowAutomationEnabled: boolean;
  monthlyMessageLimit: number;
  notificationEmail: string;
  retentionDays: number;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  errors?: Array<{
    field: string;
    message: string;
  }>;
}

export interface SaasAdminApiClient {
  auth: {
    getSession: () => Promise<AdminSession>;
    startTelegramLogin: (request: TelegramLoginStartRequest) => Promise<TelegramLoginStartResponse>;
    verifyTelegramLogin: (request: TelegramLoginVerifyRequest) => Promise<AdminSession>;
    logout: () => Promise<LogoutResponse>;
  };
  org: {
    getOrganization: (organizationId: string) => Promise<Organization>;
    updateOrganization: (
      organizationId: string,
      request: UpdateOrganizationRequest
    ) => Promise<Organization>;
    getConfiguration: (organizationId: string) => Promise<OrganizationConfiguration>;
    updateConfiguration: (
      organizationId: string,
      request: UpdateOrganizationConfigurationRequest
    ) => Promise<OrganizationConfiguration>;
  };
}
