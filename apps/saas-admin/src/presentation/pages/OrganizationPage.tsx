import { useEffect, useState } from "react";

import type { Organization, OrganizationConfiguration } from "../../api/client/types";
import { useAuth } from "../../state/auth";
import { useSaasAdminApi } from "../../state/admin";
import { Badge, Panel } from "../../shared/ui-kit";

export default function OrganizationPage() {
  const { session } = useAuth();
  const api = useSaasAdminApi();
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [configuration, setConfiguration] = useState<OrganizationConfiguration | null>(null);

  useEffect(() => {
    let active = true;

    if (!session) {
      return () => {
        active = false;
      };
    }

    Promise.all([
      api.org.getOrganization(session.organization.id),
      api.org.getConfiguration(session.organization.id)
    ]).then(([nextOrganization, nextConfiguration]) => {
      if (active) {
        setOrganization(nextOrganization);
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
        <Badge tone="neutral">Организация</Badge>
        <h1>Организация и конфигурация</h1>
        <p>Основные сведения и параметры доступны в режиме чтения.</p>
      </div>

      <div className="details-grid">
        <Panel className="detail-panel">
          <h2>{organization?.name ?? "Загрузка организации"}</h2>
          <dl>
            <div>
              <dt>Часовой пояс</dt>
              <dd>{organization?.timezone ?? "..."}</dd>
            </div>
            <div>
              <dt>Локаль</dt>
              <dd>{organization?.locale ?? "..."}</dd>
            </div>
            <div>
              <dt>Статус</dt>
              <dd>{organization?.status === "active" ? "активна" : "..."}</dd>
            </div>
          </dl>
        </Panel>

        <Panel className="detail-panel">
          <h2>Конфигурация</h2>
          <dl>
            <div>
              <dt>Язык по умолчанию</dt>
              <dd>{configuration?.defaultLanguage ?? "..."}</dd>
            </div>
            <div>
              <dt>Workflow</dt>
              <dd>{configuration?.workflowAutomationEnabled ? "включён" : "..."}</dd>
            </div>
            <div>
              <dt>Email уведомлений</dt>
              <dd>{configuration?.notificationEmail ?? "..."}</dd>
            </div>
          </dl>
        </Panel>
      </div>
    </section>
  );
}
