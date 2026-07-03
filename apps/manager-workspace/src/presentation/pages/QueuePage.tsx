import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import type { ClientProfile, Conversation } from "../../api/client/types";
import type { RealtimeConnectionStatus } from "../../api/client/realtime";
import {
  advanceC7Sequence,
  applyC7EventToClients,
  applyC7EventToConversations,
  isC7SequenceGap,
  markC7EventSeen
} from "../../state/realtime-merge";
import { useC7RealtimeClient, useManagerWorkspaceApi } from "../../state/workspace";
import { Badge, Panel, TextInput } from "../../shared/ui-kit";

const statusTone = {
  open: "success",
  pending: "warning",
  closed: "neutral"
} as const;

export default function QueuePage() {
  const api = useManagerWorkspaceApi();
  const realtime = useC7RealtimeClient();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [clients, setClients] = useState<ClientProfile[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<RealtimeConnectionStatus>("offline");
  const [queueReady, setQueueReady] = useState(false);
  const lastSequenceNumberRef = useRef<number | null>(null);
  const seenEventIdsRef = useRef(new Set<string>());
  const seenMessageIdsRef = useRef(new Set<string>());

  const loadQueue = useCallback(async () => {
    const [nextConversations, nextClients] = await Promise.all([
      api.conversations.list(),
      api.clients.list()
    ]);

    setConversations(nextConversations);
    setClients(nextClients);
    setError(null);
  }, [api]);

  useEffect(() => {
    let active = true;

    setQueueReady(false);
    loadQueue()
      .then(() => {
        if (active) {
          setError(null);
          setQueueReady(true);
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
  }, [loadQueue]);

  useEffect(() => {
    if (!queueReady) {
      return;
    }

    const connection = realtime.connect(
      (event) => {
        if (!markC7EventSeen(seenEventIdsRef.current, event)) {
          return;
        }

        if (isC7SequenceGap(lastSequenceNumberRef.current, event.sequence_number)) {
          void loadQueue().catch((nextError) => {
            setError(nextError instanceof Error ? nextError.message : "Не удалось догрузить realtime-очередь");
          });
        }

        lastSequenceNumberRef.current = advanceC7Sequence(lastSequenceNumberRef.current, event);
        setConversations((current) => applyC7EventToConversations(current, event, seenMessageIdsRef.current));
        setClients((current) => applyC7EventToClients(current, event));
      },
      setConnectionStatus
    );

    return () => {
      connection.close();
    };
  }, [loadQueue, queueReady, realtime]);

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
        <Badge tone={connectionStatus === "connected" ? "success" : connectionStatus === "reconnecting" ? "warning" : "neutral"}>
          C7 {connectionStatus}
        </Badge>
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
                {clientById.get(conversation.clientId)?.status ? (
                  <Badge tone={clientById.get(conversation.clientId)?.status === "online" ? "success" : "neutral"}>
                    {clientById.get(conversation.clientId)?.status}
                  </Badge>
                ) : null}
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
