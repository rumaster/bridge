import type {
  NormalizedWebChatRealtimeEvent,
  WebChatMessage,
  WebChatMessageStatus,
} from "../types";

export function mergeWebChatMessages(
  currentMessages: WebChatMessage[],
  nextMessages: WebChatMessage[],
): WebChatMessage[] {
  const byId = new Map<string, WebChatMessage>();

  for (const message of currentMessages) {
    byId.set(message.id, message);
  }

  for (const message of nextMessages) {
    byId.set(message.id, {
      ...byId.get(message.id),
      ...message,
      author: {
        ...byId.get(message.id)?.author,
        ...message.author,
      },
      body: {
        ...byId.get(message.id)?.body,
        ...message.body,
      },
    });
  }

  return [...byId.values()].sort(compareWebChatMessages);
}

export function applyRealtimeEventToMessages(
  currentMessages: WebChatMessage[],
  event: NormalizedWebChatRealtimeEvent,
): WebChatMessage[] {
  switch (event.type) {
    case "message.created":
      return mergeWebChatMessages(currentMessages, [event.message]);
    case "message.status_changed":
      return updateWebChatMessageStatus(currentMessages, event.messageId, event.status);
    case "typing.started":
    case "typing.stopped":
      return currentMessages;
  }
}

export function updateWebChatMessageStatus(
  currentMessages: WebChatMessage[],
  messageId: string,
  status: WebChatMessageStatus,
): WebChatMessage[] {
  return currentMessages.map((message) =>
    message.id === messageId
      ? {
          ...message,
          status,
        }
      : message,
  );
}

export function getLatestSequenceNumber(messages: WebChatMessage[]): number {
  return messages.reduce((latest, message) => {
    const sequenceNumber = getMessageSequenceNumber(message);
    return sequenceNumber === null ? latest : Math.max(latest, sequenceNumber);
  }, 0);
}

export function getMessageSequenceNumber(message: WebChatMessage): number | null {
  return typeof message.sequenceNumber === "number" && Number.isFinite(message.sequenceNumber)
    ? message.sequenceNumber
    : null;
}

function compareWebChatMessages(left: WebChatMessage, right: WebChatMessage): number {
  const leftSequence = getMessageSequenceNumber(left);
  const rightSequence = getMessageSequenceNumber(right);

  if (leftSequence !== null && rightSequence !== null && leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }

  if (leftSequence !== null && rightSequence === null) {
    return -1;
  }

  if (leftSequence === null && rightSequence !== null) {
    return 1;
  }

  const createdAtDifference =
    new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();

  if (createdAtDifference !== 0) {
    return createdAtDifference;
  }

  return left.id.localeCompare(right.id);
}
