import { FormEvent, useEffect, useMemo, useState } from "react";
import { Bell, BellRing, Check, Save } from "lucide-react";

import type { C7Event, Notification, NotificationSetting } from "../../api/client/types";
import { useC7RealtimeClient, useSaasAdminApi } from "../../state/admin";
import { hasAnyRole, useAuth } from "../../state/auth";
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  notificationCategoryLabel,
  notificationCategoryTone,
  notificationChannelLabel,
  notificationSettingKey
} from "../../shared/notifications";
import { Badge, Button, CheckboxInput, Panel } from "../../shared/ui-kit";

type NotificationCreatedEvent = Extract<C7Event, { type: "notification.created" }>;

export default function NotificationsPage() {
  const { session } = useAuth();
  const api = useSaasAdminApi();
  const realtime = useC7RealtimeClient();
  const canView = hasAnyRole(session, ["administrator"]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [settings, setSettings] = useState<NotificationSetting[]>([]);
  const [draftSettings, setDraftSettings] = useState<Record<string, boolean>>({});
  const [alert, setAlert] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [realtimeStatus, setRealtimeStatus] = useState("offline");

  useEffect(() => {
    let active = true;

    if (!session || !canView) {
      setLoading(false);
      return () => {
        active = false;
      };
    }

    setLoading(true);
    Promise.all([api.notifications.listNotifications(), api.notifications.getSettings()])
      .then(async ([feed, settingsResponse]) => {
        const initialEvents = await realtime.collectInitialEvents().catch(() => []);
        const nextNotifications = applyNotificationEvents(feed.items, initialEvents);
        if (active) {
          setNotifications(nextNotifications);
          setSettings(settingsResponse.settings);
          setDraftSettings(toDraftSettings(settingsResponse.settings));
          setAlert(null);
        }
      })
      .catch((error) => {
        if (active) {
          setAlert(getProblemMessage(error, "Не удалось загрузить уведомления."));
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [api, canView, realtime, session]);

  useEffect(() => {
    if (!canView) {
      return undefined;
    }

    const connection = realtime.connect(
      (event) => {
        if (event.type === "notification.created") {
          setNotifications((current) => prependNotification(current, event));
        }
      },
      (status) => setRealtimeStatus(status)
    );

    return () => connection.close();
  }, [canView, realtime]);

  const unreadCount = useMemo(
    () => notifications.filter((item) => item.status === "new").length,
    [notifications]
  );

  const settingsDirty = useMemo(
    () =>
      settings.some(
        (setting) =>
          draftSettings[notificationSettingKey(setting.category, setting.channel)] !==
          setting.enabled
      ),
    [settings, draftSettings]
  );

  function toggleSetting(key: string) {
    setDraftSettings((current) => ({ ...current, [key]: !current[key] }));
    setSuccess(null);
  }

  async function handleMarkRead(notificationId: string) {
    setMarkingId(notificationId);
    setAlert(null);

    try {
      const response = await api.notifications.markRead(notificationId);
      setNotifications((current) =>
        current.map((item) => (item.id === notificationId ? response.notification : item))
      );
    } catch (error) {
      setAlert(getProblemMessage(error, "Не удалось отметить уведомление прочитанным."));
    } finally {
      setMarkingId(null);
    }
  }

  async function handleSaveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!session) {
      return;
    }

    setSavingSettings(true);
    setAlert(null);
    setSuccess(null);

    try {
      const nextSettings: NotificationSetting[] = settings.map((setting) => ({
        category: setting.category,
        channel: setting.channel,
        enabled: draftSettings[notificationSettingKey(setting.category, setting.channel)] ?? false
      }));

      const response = await api.notifications.updateSettings({
        organization_id: session.organization.id,
        user_id: session.user.id,
        settings: nextSettings
      });

      setSettings(response.settings);
      setDraftSettings(toDraftSettings(response.settings));
      setSuccess("Настройки уведомлений сохранены");
    } catch (error) {
      setAlert(getProblemMessage(error, "Не удалось сохранить настройки уведомлений."));
    } finally {
      setSavingSettings(false);
    }
  }

  return (
    <section className="page-section">
      <div className="page-heading">
        <Badge tone="neutral">Уведомления</Badge>
        <h1>Notification</h1>
        <p>Лента и настройки доставки управляются через фасад C10 (CP-8, ТЗ §15.4).</p>
      </div>

      {!canView ? (
        <Panel className="empty-state">
          <Badge tone="warning">Роль</Badge>
          <h2>Раздел доступен только администратору организации</h2>
        </Panel>
      ) : null}

      {alert ? (
        <div className="form-alert" role="alert">
          {alert}
        </div>
      ) : null}

      {success ? <div className="form-success">{success}</div> : null}

      {canView ? (
        <>
          <div className="summary-grid">
            <Panel className="summary-panel">
              <span className="metric-label">Всего уведомлений</span>
              <strong>{notifications.length}</strong>
            </Panel>
            <Panel className="summary-panel">
              <span className="metric-label">Непрочитанных</span>
              <strong>{unreadCount}</strong>
            </Panel>
            <Panel className="summary-panel">
              <span className="metric-label">C7</span>
              <strong>{getRealtimeStatusLabel(realtimeStatus)}</strong>
            </Panel>
          </div>

          {loading ? <div className="route-loader">Загрузка уведомлений...</div> : null}

          <Panel>
            <div className="panel-heading-row">
              <div>
                <h2>Лента уведомлений</h2>
                <p>UI отображает уведомления и отмечает «прочитано»; доставку выполняет SVC-NOTIF.</p>
              </div>
            </div>
            {notifications.length > 0 ? (
              <ul className="notification-feed">
                {notifications.map((notification) => (
                  <NotificationItem
                    key={notification.id}
                    marking={markingId === notification.id}
                    notification={notification}
                    onMarkRead={() => void handleMarkRead(notification.id)}
                  />
                ))}
              </ul>
            ) : (
              <div className="empty-state">
                <Bell aria-hidden="true" size={28} />
                <span>Уведомлений пока нет.</span>
              </div>
            )}
          </Panel>

          <Panel as="form" onSubmit={(event) => void handleSaveSettings(event)}>
            <div className="panel-heading-row">
              <div>
                <h2>Каналы доставки по категориям</h2>
                <p>Web, Telegram, Email и Push — по каждой категории уведомлений (ТЗ §15.4).</p>
              </div>
              <Button disabled={savingSettings || !settingsDirty} type="submit">
                <Save aria-hidden="true" size={16} />
                Сохранить настройки
              </Button>
            </div>
            <table className="notification-settings" aria-label="Настройки каналов доставки">
              <thead>
                <tr>
                  <th scope="col">Категория</th>
                  {NOTIFICATION_CHANNELS.map((channel) => (
                    <th key={channel} scope="col">
                      {notificationChannelLabel(channel)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {NOTIFICATION_CATEGORIES.map((category) => (
                  <tr key={category}>
                    <th scope="row">
                      <Badge tone={notificationCategoryTone(category)}>
                        {notificationCategoryLabel(category)}
                      </Badge>
                    </th>
                    {NOTIFICATION_CHANNELS.map((channel) => {
                      const key = notificationSettingKey(category, channel);
                      return (
                        <td key={channel}>
                          <CheckboxInput
                            checked={draftSettings[key] ?? false}
                            id={`setting-${key}`}
                            label={`${notificationCategoryLabel(category)} · ${notificationChannelLabel(channel)}`}
                            onChange={() => toggleSetting(key)}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </>
      ) : null}
    </section>
  );
}

interface NotificationItemProps {
  marking: boolean;
  notification: Notification;
  onMarkRead: () => void;
}

function NotificationItem({ marking, notification, onMarkRead }: NotificationItemProps) {
  const isNew = notification.status === "new";

  return (
    <li className={`notification-item status-${notification.status}`}>
      <Panel as="article" aria-label={`Уведомление ${notification.title}`}>
        <div className="panel-heading-row">
          <div className="notification-title">
            {isNew ? <BellRing aria-hidden="true" size={20} /> : <Bell aria-hidden="true" size={20} />}
            <div>
              <h3>{notification.title}</h3>
              <span className="muted">{notification.body}</span>
            </div>
          </div>
          <Badge tone={notificationCategoryTone(notification.category)}>
            {notificationCategoryLabel(notification.category)}
          </Badge>
        </div>
        <div className="notification-channels">
          {notification.channels.map((channel) => (
            <Badge key={channel} tone="neutral">
              {notificationChannelLabel(channel)}
            </Badge>
          ))}
        </div>
        <div className="form-actions">
          {isNew ? (
            <Button disabled={marking} onClick={onMarkRead} type="button" variant="secondary">
              <Check aria-hidden="true" size={16} />
              Отметить прочитанным
            </Button>
          ) : (
            <span className="inline-status">Прочитано</span>
          )}
        </div>
      </Panel>
    </li>
  );
}

function toDraftSettings(settings: NotificationSetting[]): Record<string, boolean> {
  return Object.fromEntries(
    settings.map((setting) => [
      notificationSettingKey(setting.category, setting.channel),
      setting.enabled
    ])
  );
}

function prependNotification(notifications: Notification[], event: NotificationCreatedEvent) {
  const incoming = event.payload.notification;
  const withoutDuplicate = notifications.filter((item) => item.id !== incoming.id);
  return [incoming, ...withoutDuplicate];
}

function applyNotificationEvents(notifications: Notification[], events: C7Event[]) {
  return events.reduce(
    (current, event) =>
      event.type === "notification.created" ? prependNotification(current, event) : current,
    notifications
  );
}

function getRealtimeStatusLabel(status: string) {
  switch (status) {
    case "connected":
      return "online";
    case "reconnecting":
      return "reconnect";
    default:
      return "offline";
  }
}

function getProblemMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}
