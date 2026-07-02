export type ISODateTime = string;

export interface AdminSession {
  token: string;
  user: {
    id: string;
    displayName: string;
    role: "administrator";
    telegramUsername: string;
  };
  organization: {
    id: string;
    name: string;
    status: "active" | "blocked";
  };
  expiresAt: ISODateTime;
}

export interface TelegramLoginStartRequest {
  telegramUsername: string;
}

export interface TelegramLoginStartResponse {
  requestId: string;
  delivery: "telegram";
  expiresAt: ISODateTime;
}

export interface TelegramLoginVerifyRequest {
  requestId: string;
  code: string;
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

export interface OrganizationConfiguration {
  organizationId: string;
  defaultLanguage: string;
  aiAssistantEnabled: boolean;
  workflowAutomationEnabled: boolean;
  notificationEmail: string;
  updatedAt: ISODateTime;
}

export interface SaasAdminApiClient {
  auth: {
    getSession: () => Promise<AdminSession>;
    startTelegramLogin: (request: TelegramLoginStartRequest) => Promise<TelegramLoginStartResponse>;
    verifyTelegramLogin: (request: TelegramLoginVerifyRequest) => Promise<AdminSession>;
    logout: () => Promise<void>;
  };
  org: {
    getOrganization: (organizationId: string) => Promise<Organization>;
    getConfiguration: (organizationId: string) => Promise<OrganizationConfiguration>;
  };
}
