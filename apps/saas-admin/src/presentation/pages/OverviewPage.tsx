import { useEffect, useState } from "react";
import { Bell, BookOpen, Cable, RadioTower, Workflow } from "lucide-react";

import type { OrganizationConfiguration } from "../../api/client/types";
import { useAuth } from "../../state/auth";
import { useSaasAdminApi } from "../../state/admin";
import { Badge, Panel } from "../../shared/ui-kit";

const readinessItems = [
  { label: "Каналы", value: "маршрут готов", icon: Cable },
  { label: "Knowledge Base", value: "маршрут готов", icon: BookOpen },
  { label: "Workflow", value: "lazy module", icon: Workflow },
  { label: "Broadcast", value: "маршрут готов", icon: RadioTower },
  { label: "Уведомления", value: "маршрут готов", icon: Bell }
];

export default function OverviewPage() {
  const { session } = useAuth();
  const api = useSaasAdminApi();
  const [configuration, setConfiguration] = useState<OrganizationConfiguration | null>(null);

  useEffect(() => {
    let active = true;

    if (!session) {
      return () => {
        active = false;
      };
    }

    api.org.getConfiguration(session.organization.id).then((nextConfiguration) => {
      if (active) {
        setConfiguration(nextConfiguration);
      }
    });

    return () => {
      active = false;
    };
  }, [api, session]);

  return (
    <section className="page-section">
      <div className="page-heading">
        <Badge tone="success">M1</Badge>
        <h1>Административная панель</h1>
        <p>Сессия администратора и конфигурация организации загружены через Backend API.</p>
      </div>

      <div className="summary-grid">
        <Panel className="summary-panel">
          <span className="metric-label">Организация</span>
          <strong>{session?.organization.name}</strong>
          <span className="muted">
            Пользователь: {session?.user.status === "active" ? "активен" : "заблокирован"}
          </span>
        </Panel>
        <Panel className="summary-panel">
          <span className="metric-label">Workflow</span>
          <strong>{configuration?.workflowAutomationEnabled ? "включён" : "ожидает данных"}</strong>
          <span className="muted">Параметры получены из конфигурации организации</span>
        </Panel>
        <Panel className="summary-panel">
          <span className="metric-label">AI Assistant</span>
          <strong>{configuration?.aiAssistantEnabled ? "включён" : "ожидает данных"}</strong>
          <span className="muted">Изменение параметров появится в конфигурации</span>
        </Panel>
      </div>

      <div className="module-grid">
        {readinessItems.map(({ icon: Icon, label, value }) => (
          <Panel className="module-tile" key={label}>
            <Icon aria-hidden="true" size={20} />
            <span>{label}</span>
            <Badge>{value}</Badge>
          </Panel>
        ))}
      </div>
    </section>
  );
}
