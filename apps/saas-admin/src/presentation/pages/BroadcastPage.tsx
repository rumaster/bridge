import { RadioTower } from "lucide-react";

import { Badge, Panel } from "../../shared/ui-kit";

export default function BroadcastPage() {
  return (
    <section className="page-section">
      <div className="page-heading">
        <Badge tone="neutral">Рассылки</Badge>
        <h1>Broadcast</h1>
        <p>Раздел подготовлен для кампаний, запуска рассылок и статистики доставки.</p>
      </div>
      <Panel className="empty-state">
        <RadioTower aria-hidden="true" size={28} />
        <span>Список кампаний появится после подключения API.</span>
      </Panel>
    </section>
  );
}
