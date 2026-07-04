import type {
  NotificationListFacadeRequest,
  NotificationListFacadeResponse,
  NotificationReadFacadeRequest,
  NotificationReadFacadeResponse,
  NotificationSettingsFacadeRequest,
  NotificationSettingsFacadeResponse,
  NotificationSettingsUpdateFacadeRequest,
} from "./notification-facade.facade";

/**
 * Contract-level client for SVC-NOTIF (C10). Tests bind deterministic contract
 * mocks; a live transport remains outside this M4 facade.
 */
export interface NotificationUpstreamClient {
  listNotifications(
    request: NotificationListFacadeRequest,
  ): Promise<NotificationListFacadeResponse>;
  markNotificationRead(
    request: NotificationReadFacadeRequest,
  ): Promise<NotificationReadFacadeResponse>;
  getNotificationSettings(
    request: NotificationSettingsFacadeRequest,
  ): Promise<NotificationSettingsFacadeResponse>;
  updateNotificationSettings(
    request: NotificationSettingsUpdateFacadeRequest,
  ): Promise<NotificationSettingsFacadeResponse>;
}

export const NOTIFICATION_UPSTREAM_CLIENT = "NOTIFICATION_UPSTREAM_CLIENT";
