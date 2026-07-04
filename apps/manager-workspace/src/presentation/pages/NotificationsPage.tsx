import type { NotificationCategory } from "../../api/client/types";
import { useNotifications } from "../../state/notifications";
import { Badge, Button, Panel } from "../../shared/ui-kit";
import type { BadgeTone } from "../../shared/ui-kit";

const categoryLabels: Record<NotificationCategory, string> = {
  info: "Информация",
  warning: "Предупреждение",
  error: "Ошибка",
  critical: "Критично",
  admin: "Администрирование"
};

const categoryTones: Record<NotificationCategory, BadgeTone> = {
  info: "info",
  warning: "warning",
  error: "danger",
  critical: "danger",
  admin: "neutral"
};

export default function NotificationsPage() {
  const { notifications, unreadCount, connectionStatus, loading, error, markRead } = useNotifications();

  return (
    <section className="page-section">
      <div className="page-heading">
        <Badge tone="neutral">C10.notifications · C7</Badge>
        <h1>Уведомления</h1>
        <div className="realtime-meta">
          <span>Непрочитанных: {unreadCount}</span>
          <Badge
            tone={
              connectionStatus === "connected"
                ? "success"
                : connectionStatus === "reconnecting"
                  ? "warning"
                  : "neutral"
            }
          >
            C7 {connectionStatus}
          </Badge>
        </div>
      </div>

      {error ? <p className="error-text">{error}</p> : null}

      {loading && notifications.length === 0 ? <p className="muted">Загрузка уведомлений...</p> : null}

      {!loading && notifications.length === 0 ? (
        <p className="muted">Новых уведомлений нет.</p>
      ) : null}

      <div className="notification-list">
        {notifications.map((notification) => (
          <Panel as="article" className="notification-row" key={notification.id}>
            <div className="notification-main">
              <div className="row-title">
                <span>{notification.title}</span>
                <Badge tone={categoryTones[notification.category]}>
                  {categoryLabels[notification.category]}
                </Badge>
                <Badge tone={notification.status === "new" ? "success" : "neutral"}>
                  {notification.status}
                </Badge>
              </div>
              <p>{notification.body}</p>
            </div>

            {notification.status === "new" ? (
              <div className="row-meta">
                <Button
                  onClick={() => {
                    void markRead(notification.id);
                  }}
                  type="button"
                  variant="secondary"
                >
                  Отметить прочитанным
                </Button>
              </div>
            ) : null}
          </Panel>
        ))}
      </div>
    </section>
  );
}
