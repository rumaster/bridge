import { Users } from "lucide-react";

import { Badge, Panel } from "../../shared/ui-kit";

export default function UsersPage() {
  return (
    <section className="page-section">
      <div className="page-heading">
        <Badge tone="neutral">Доступы</Badge>
        <h1>Пользователи и роли</h1>
        <p>Раздел подготовлен для управления пользователями, ролями и приглашениями.</p>
      </div>
      <Panel className="empty-state">
        <Users aria-hidden="true" size={28} />
        <span>Список пользователей появится после подключения API.</span>
      </Panel>
    </section>
  );
}
