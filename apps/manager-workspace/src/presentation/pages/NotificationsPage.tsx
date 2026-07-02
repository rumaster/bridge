import { useEffect, useState } from "react";

import type { NotificationItem } from "../../api/client/types";
import { useManagerWorkspaceApi } from "../../state/workspace";
import { Badge, Panel } from "../../shared/ui-kit";

export default function NotificationsPage() {
  const api = useManagerWorkspaceApi();
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);

  useEffect(() => {
    let active = true;

    api.notifications.list().then((items) => {
      if (active) {
        setNotifications(items);
      }
    });

    return () => {
      active = false;
    };
  }, [api]);

  return (
    <section className="page-section">
      <div className="page-heading">
        <Badge tone="neutral">C10.notifications</Badge>
        <h1>Уведомления</h1>
      </div>

      <div className="notification-list">
        {notifications.map((notification) => (
          <Panel as="article" className="notification-row" key={notification.id}>
            <div className="row-title">
              <span>{notification.title}</span>
              <Badge tone={notification.status === "new" ? "success" : "neutral"}>
                {notification.status}
              </Badge>
            </div>
            <p>{notification.body}</p>
          </Panel>
        ))}
      </div>
    </section>
  );
}
