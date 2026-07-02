import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import type { Conversation } from "../../api/client/types";
import { useManagerWorkspaceApi } from "../../state/workspace";
import { Badge, Panel } from "../../shared/ui-kit";

export default function QueuePage() {
  const api = useManagerWorkspaceApi();
  const [conversations, setConversations] = useState<Conversation[]>([]);

  useEffect(() => {
    let active = true;

    api.conversations.list().then((items) => {
      if (active) {
        setConversations(items);
      }
    });

    return () => {
      active = false;
    };
  }, [api]);

  return (
    <section className="page-section">
      <div className="page-heading">
        <Badge tone="neutral">C3.conversations</Badge>
        <h1>Очередь диалогов</h1>
      </div>

      <div className="conversation-list">
        {conversations.map((conversation) => (
          <Panel as="article" className="conversation-row" key={conversation.id}>
            <div>
              <div className="row-title">
                <span>{conversation.clientId === "client-1" ? "Анна Петрова" : "Илья Смирнов"}</span>
                <Badge tone={conversation.status === "open" ? "success" : "warning"}>{conversation.status}</Badge>
              </div>
              <p>{conversation.lastMessagePreview}</p>
            </div>
            <div className="row-meta">
              <span>{conversation.channel}</span>
              <Link className="inline-link" to={`/dialogs/${conversation.id}`}>
                Открыть
              </Link>
            </div>
          </Panel>
        ))}
      </div>
    </section>
  );
}
