/**
 * Realtime-потребитель C7 для SVC-MOB (M4, ТЗ §19.3, §19.4, §15.4). Подписывается
 * на события ядра (message.created, message.status_changed, notification.created,
 * typing.*), проецирует их в мок-Backend (дедуп по event_id внутри Backend) и
 * реализует fallback «нет живого WS у получателя → push + последующий sync».
 *
 * SVC-MOB здесь только потребляет и переупаковывает — порядок/буфер/дедуп на
 * разрыве обеспечивает C7/Edge (границы §1, §7.10).
 */
export interface RealtimeConnectOptions {
  subscription?: any;
  afterSequenceNumber?: number;
  lastEventId?: string;
}

export function createRealtimeConsumer({ backend, pushDispatcher, registry }) {
  const metrics = {
    realtime_events_total: 0,
    realtime_message_created_total: 0,
    realtime_message_status_total: 0,
    realtime_notification_total: 0,
    realtime_typing_total: 0,
    realtime_duplicate_total: 0,
    realtime_ws_delivered_total: 0,
    realtime_push_fallback_total: 0,
  };

  function handleEvent(event) {
    metrics.realtime_events_total += 1;
    const result = backend.ingestRealtimeEvent(event);

    if (result.duplicate) {
      metrics.realtime_duplicate_total += 1;
      return { ...result, pushed: null };
    }

    const type = event.event;
    if (type === "message.created") {
      metrics.realtime_message_created_total += 1;
    } else if (type === "message.status_changed") {
      metrics.realtime_message_status_total += 1;
    } else if (type === "typing.started" || type === "typing.stopped") {
      metrics.realtime_typing_total += 1;
    }

    let pushed = null;
    if (type === "notification.created") {
      metrics.realtime_notification_total += 1;
      pushed = maybePush(event);
    }

    return { ...result, pushed };
  }

  // Fallback §19.4/§15.4: если у получателя нет живого WS-устройства — доставляем
  // push (клиент затем добьёт состояние через GET /sync). Иначе realtime уже
  // доставлен по WS и дублировать push не нужно.
  function maybePush(event) {
    const notification = event.notification ?? event.payload?.notification ?? null;
    const recipient =
      notification?.recipient_user_id ??
      notification?.user_id ??
      event.recipient_user_id ??
      null;

    if (!recipient) {
      return null;
    }

    if (registry.hasOnlineDevice(recipient)) {
      metrics.realtime_ws_delivered_total += 1;
      return null;
    }

    metrics.realtime_push_fallback_total += 1;
    return pushDispatcher.dispatchToUser(recipient, notification);
  }

  return {
    handleEvent,

    /**
     * Подключение к мок-WS (совместимо с createMockWebSocketChannel): реплей
     * сохранённых событий после курсора + живой поток. Возвращает управление
     * закрытием и последний применённый event_id (для докачки при реконнекте).
     */
    connect(wsChannel, { subscription, afterSequenceNumber, lastEventId }: RealtimeConnectOptions = {}) {
      return wsChannel.connect({
        subscription,
        afterSequenceNumber,
        lastEventId,
        send: (event) => handleEvent(event),
      });
    },

    getMetrics() {
      return { ...metrics };
    },
  };
}
