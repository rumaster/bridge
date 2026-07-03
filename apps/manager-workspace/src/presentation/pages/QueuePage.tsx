import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import type { ClientProfile, Conversation } from "../../api/client/types";
import { useManagerWorkspaceApi } from "../../state/workspace";
import { Badge, Panel, TextInput } from "../../shared/ui-kit";

const statusTone = {
  open: "success",
  pending: "warning",
  closed: "neutral"
} as const;

export default function QueuePage() {
  const api = useManagerWorkspaceApi();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [clients, setClients] = useState<ClientProfile[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    Promise.all([api.conversations.list(), api.clients.list()])
      .then(([nextConversations, nextClients]) => {
        if (active) {
          setConversations(nextConversations);
          setClients(nextClients);
          setError(null);
        }
      })
      .catch((nextError) => {
        if (active) {
          setError(nextError instanceof Error ? nextError.message : "Не удалось загрузить очередь");
        }
      });

    return () => {
      active = false;
    };
  }, [api]);

  const clientById = new Map(clients.map((client) => [client.id, client]));
  const normalizedSearch = search.trim().toLowerCase();
  const filteredConversations = conversations.filter((conversation) => {
    if (!normalizedSearch) {
      return true;
    }

    const client = clientById.get(conversation.clientId);
    const searchableText = [
      client?.displayName,
      client?.tags.join(" "),
      client?.endpoints.map((endpoint) => endpoint.externalId).join(" "),
      conversation.lastMessagePreview,
      conversation.status,
      conversation.channel
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return searchableText.includes(normalizedSearch);
  });

  return (
    <section className="page-section">
      <div className="page-heading">
        <Badge tone="neutral">C3.conversations</Badge>
        <h1>Очередь диалогов</h1>
      </div>

      <div className="queue-toolbar">
        <TextInput
          label="Поиск клиента"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Имя, endpoint, статус"
          value={search}
        />
      </div>

      {error ? <p className="error-text">{error}</p> : null}

      <div className="conversation-list">
        {filteredConversations.map((conversation) => (
          <Panel as="article" className="conversation-row" key={conversation.id}>
            <div>
              <div className="row-title">
                <span>{clientById.get(conversation.clientId)?.displayName ?? conversation.clientId}</span>
                <Badge tone={statusTone[conversation.status]}>{conversation.status}</Badge>
              </div>
              <p>{conversation.lastMessagePreview}</p>
            </div>
            <div className="row-meta">
              <span>{conversation.channel}</span>
              <span>{conversation.unreadCount} новых</span>
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
