import { Bell } from "lucide-react";

import { Badge, Panel } from "../../shared/ui-kit";

export default function NotificationsPage() {
  return (
    <section className="page-section">
      <div className="page-heading">
        <Badge tone="neutral">События</Badge>
        <h1>Уведомления</h1>
        <p>Раздел подготовлен для ленты уведомлений и настроек доставки.</p>
      </div>
      <Panel className="empty-state">
        <Bell aria-hidden="true" size={28} />
        <span>Лента уведомлений появится после подключения API.</span>
      </Panel>
    </section>
  );
}
