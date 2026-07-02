import { BookOpen } from "lucide-react";

import { Badge, Panel } from "../../shared/ui-kit";

export default function KnowledgePage() {
  return (
    <section className="page-section">
      <div className="page-heading">
        <Badge tone="neutral">Знания</Badge>
        <h1>Knowledge Base</h1>
        <p>Раздел подготовлен для документов, переиндексации и статусов индекса.</p>
      </div>
      <Panel className="empty-state">
        <BookOpen aria-hidden="true" size={28} />
        <span>Список документов появится после подключения API.</span>
      </Panel>
    </section>
  );
}
