import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";

import type { ClientProfile, Conversation, Message } from "../../api/client/types";
import { useManagerWorkspaceApi } from "../../state/workspace";
import { Badge, Panel } from "../../shared/ui-kit";

export default function DialogPage() {
  const { conversationId = "conv-1" } = useParams();
  const api = useManagerWorkspaceApi();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [client, setClient] = useState<ClientProfile | null>(null);

  useEffect(() => {
    let active = true;

    async function loadDialog() {
      const nextConversation = await api.conversations.get(conversationId);
      const [nextMessages, nextClient] = await Promise.all([
        api.conversations.listMessages(conversationId),
        api.clients.get(nextConversation.clientId)
      ]);

      if (active) {
        setConversation(nextConversation);
        setMessages(nextMessages);
        setClient(nextClient);
      }
    }

    loadDialog();

    return () => {
      active = false;
    };
  }, [api, conversationId]);

  const channelLabel = useMemo(() => conversation?.channel.replace("_", " ") ?? "mock", [conversation]);

  return (
    <section className="page-section">
      <div className="page-heading">
        <Badge tone="neutral">C3.messages · C3.clients</Badge>
        <h1>Диалог</h1>
        <p>{client ? client.displayName : "Загрузка клиента"} · {channelLabel}</p>
      </div>

      <div className="dialog-layout">
        <Panel className="message-thread">
          {messages.map((message) => (
            <article className={`message-bubble ${message.direction}`} key={message.id}>
              <span>{message.content}</span>
              <small>{message.status}</small>
            </article>
          ))}
        </Panel>

        <Panel className="client-card">
          <h2>Карточка клиента</h2>
          <p>{client?.displayName ?? "Загрузка"}</p>
          <div className="tag-list">
            {client?.tags.map((tag) => (
              <Badge key={tag} tone="neutral">
                {tag}
              </Badge>
            ))}
          </div>
        </Panel>
      </div>
    </section>
  );
}
