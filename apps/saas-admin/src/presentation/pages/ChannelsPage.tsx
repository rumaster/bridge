import { Cable } from "lucide-react";

import { Badge, Panel } from "../../shared/ui-kit";

export default function ChannelsPage() {
  return (
    <section className="page-section">
      <div className="page-heading">
        <Badge tone="neutral">Интеграции</Badge>
        <h1>Каналы связи</h1>
        <p>Раздел подготовлен для статусов подключения, возможностей каналов и журнала ошибок.</p>
      </div>
      <Panel className="empty-state">
        <Cable aria-hidden="true" size={28} />
        <span>Карточки каналов появятся после подключения API.</span>
      </Panel>
    </section>
  );
}
