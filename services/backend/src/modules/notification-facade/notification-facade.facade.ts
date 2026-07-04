import { Injectable } from "@nestjs/common";

import { FacadeResilience } from "../../common/resilience/resilience";
import type {
  FacadeResilienceOptions,
  ResilienceRejectionReason,
} from "../../common/resilience/resilience";
import type { FacadeStatusDto } from "../ai-integration/ai-integration.facade";

export type NotificationFacadeDegradationReason = "timeout" | "unavailable";
export type NotificationCategory = "info" | "warning" | "error" | "critical" | "admin";
export type NotificationChannel = "web" | "telegram" | "email" | "push";
export type NotificationStatus = "new" | "read";

export interface NotificationItemFacade {
  contract: "C10.Notification";
  version: "1.0.0";
  id: string;
  organization_id: string;
  recipient_user_id: string;
  category: NotificationCategory;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  status: NotificationStatus;
  channels: NotificationChannel[];
  created_at: string;
  read_at: string | null;
  dedupe_key?: string;
}

export interface NotificationSettingFacade {
  category: NotificationCategory;
  channel: NotificationChannel;
  enabled: boolean;
}

export interface NotificationListFacadeRequest {
  request_id: string;
  organization_id: string;
  user_id: string;
  status?: NotificationStatus;
  category?: NotificationCategory;
  cursor?: string;
  limit?: number;
}

export interface NotificationReadFacadeRequest {
  request_id: string;
  organization_id: string;
  user_id: string;
  notification_id: string;
}

export interface NotificationSettingsFacadeRequest {
  request_id: string;
  organization_id: string;
  user_id: string;
}

export interface NotificationSettingsUpdateFacadeRequest
  extends NotificationSettingsFacadeRequest {
  settings: NotificationSettingFacade[];
}

export interface NotificationListFacadeResponse {
  contract: "C10.ListNotificationsResponse";
  version: "1.0.0";
  request_id: string;
  organization_id: string;
  recipient_user_id: string;
  items: NotificationItemFacade[];
  page: {
    limit: number;
    next_cursor: string | null;
  };
  degraded?: boolean;
  fallback_reason?: NotificationFacadeDegradationReason | null;
}

export interface NotificationReadFacadeResponse {
  contract: "C10.MarkNotificationReadResponse";
  version: "1.0.0";
  request_id: string;
  organization_id: string;
  notification: NotificationItemFacade;
  degraded?: boolean;
  fallback_reason?: NotificationFacadeDegradationReason | null;
}

export interface NotificationSettingsFacadeResponse {
  contract: "C10.NotificationSettingsResponse";
  version: "1.0.0";
  request_id: string;
  organization_id: string;
  user_id: string;
  settings: NotificationSettingFacade[];
  degraded?: boolean;
  fallback_reason?: NotificationFacadeDegradationReason | null;
}

export interface NotificationFacadeCallOptions<TResponse> {
  call?: () => Promise<TResponse>;
  timeoutMs?: number;
  now?: () => string;
}

const C10_VERSION = "1.0.0";
const DEFAULT_NOTIFICATION_TIMEOUT_MS = 250;

@Injectable()
export class NotificationFacade {
  private readonly resilience: FacadeResilience;

  constructor(options: FacadeResilienceOptions = {}) {
    this.resilience = new FacadeResilience({
      defaultTimeoutMs: DEFAULT_NOTIFICATION_TIMEOUT_MS,
      retry: {
        delayMs: 1,
        maxAttempts: 2,
        maxQueue: 16,
      },
      ...options,
    });
  }

  getStatus(): FacadeStatusDto {
    return {
      mode: "mock",
      name: "notification",
      serviceId: "SVC-NOTIF",
      status: "degraded",
    };
  }

  async listNotifications(
    request: NotificationListFacadeRequest,
    options: NotificationFacadeCallOptions<NotificationListFacadeResponse> = {},
  ): Promise<NotificationListFacadeResponse> {
    const result = await this.resilience.execute(options.call, {
      timeoutMs: options.timeoutMs,
    });
    if (result.ok) {
      return result.value;
    }

    return this.createListFallback(request, toDegradationReason(result.reason));
  }

  async markNotificationRead(
    request: NotificationReadFacadeRequest,
    options: NotificationFacadeCallOptions<NotificationReadFacadeResponse> = {},
  ): Promise<NotificationReadFacadeResponse> {
    const result = await this.resilience.execute(options.call, {
      timeoutMs: options.timeoutMs,
    });
    if (result.ok) {
      return result.value;
    }

    return this.createReadFallback(request, toDegradationReason(result.reason), options.now);
  }

  async getNotificationSettings(
    request: NotificationSettingsFacadeRequest,
    options: NotificationFacadeCallOptions<NotificationSettingsFacadeResponse> = {},
  ): Promise<NotificationSettingsFacadeResponse> {
    const result = await this.resilience.execute(options.call, {
      timeoutMs: options.timeoutMs,
    });
    if (result.ok) {
      return result.value;
    }

    return this.createSettingsFallback(request, toDegradationReason(result.reason));
  }

  async updateNotificationSettings(
    request: NotificationSettingsUpdateFacadeRequest,
    options: NotificationFacadeCallOptions<NotificationSettingsFacadeResponse> = {},
  ): Promise<NotificationSettingsFacadeResponse> {
    const result = await this.resilience.execute(options.call, {
      timeoutMs: options.timeoutMs,
    });
    if (result.ok) {
      return result.value;
    }

    return this.createSettingsFallback(request, toDegradationReason(result.reason));
  }

  private createListFallback(
    request: NotificationListFacadeRequest,
    reason: NotificationFacadeDegradationReason,
  ): NotificationListFacadeResponse {
    return {
      contract: "C10.ListNotificationsResponse",
      version: C10_VERSION,
      request_id: request.request_id,
      organization_id: request.organization_id,
      recipient_user_id: request.user_id,
      items: [],
      page: {
        limit: request.limit ?? 50,
        next_cursor: null,
      },
      degraded: true,
      fallback_reason: reason,
    };
  }

  private createReadFallback(
    request: NotificationReadFacadeRequest,
    reason: NotificationFacadeDegradationReason,
    now = () => new Date().toISOString(),
  ): NotificationReadFacadeResponse {
    const timestamp = now();

    return {
      contract: "C10.MarkNotificationReadResponse",
      version: C10_VERSION,
      request_id: request.request_id,
      organization_id: request.organization_id,
      notification: {
        contract: "C10.Notification",
        version: C10_VERSION,
        id: request.notification_id,
        organization_id: request.organization_id,
        recipient_user_id: request.user_id,
        category: "info",
        title: "Notification read acknowledgement unavailable",
        body: "",
        payload: {
          reason: `notification_${reason}`,
        },
        status: "read",
        channels: ["web"],
        created_at: timestamp,
        read_at: timestamp,
      },
      degraded: true,
      fallback_reason: reason,
    };
  }

  private createSettingsFallback(
    request: NotificationSettingsFacadeRequest,
    reason: NotificationFacadeDegradationReason,
  ): NotificationSettingsFacadeResponse {
    return {
      contract: "C10.NotificationSettingsResponse",
      version: C10_VERSION,
      request_id: request.request_id,
      organization_id: request.organization_id,
      user_id: request.user_id,
      settings: [],
      degraded: true,
      fallback_reason: reason,
    };
  }
}

function toDegradationReason(
  reason: ResilienceRejectionReason,
): NotificationFacadeDegradationReason {
  return reason === "timeout" ? "timeout" : "unavailable";
}
