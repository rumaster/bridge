import { Workflow } from "lucide-react";

import { Badge, Panel } from "../../shared/ui-kit";

export default function WorkflowPage() {
  return (
    <section className="page-section">
      <div className="page-heading">
        <Badge tone="neutral">Автоматизация</Badge>
        <h1>Workflow</h1>
        <p>Раздел подготовлен для редактора схем, версий и диагностики запусков.</p>
      </div>
      <Panel className="empty-state">
        <Workflow aria-hidden="true" size={28} />
        <span>Редактор схем появится после подключения API.</span>
      </Panel>
    </section>
  );
}
