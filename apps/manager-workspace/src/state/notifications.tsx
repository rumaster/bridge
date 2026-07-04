import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { PropsWithChildren } from "react";

import type { RealtimeConnectionStatus } from "../api/client/realtime";
import type { NotificationItem } from "../api/client/types";
import {
  applyC7EventToNotifications,
  countUnreadNotifications,
  markC7EventSeen,
  markNotificationReadById,
  mergeNotificationsById
} from "./realtime-merge";
import { useC7RealtimeClient, useManagerWorkspaceApi } from "./workspace";

export interface NotificationsContextValue {
  notifications: NotificationItem[];
  unreadCount: number;
  connectionStatus: RealtimeConnectionStatus;
  loading: boolean;
  error: string | null;
  markRead: (notificationId: string) => Promise<void>;
}

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

/**
 * Общий источник состояния центра уведомлений (CP-8). Держит список уведомлений
 * C10 `GET /notifications`, счётчик непрочитанных для индикатора и подписку на
 * realtime-событие C7 `notification.created`. Провайдер поднимается над
 * рабочим местом менеджера, поэтому индикатор в шапке и список уведомлений
 * используют единый счётчик и синхронизируются при отметке прочтения.
 */
export function NotificationsProvider({ children }: PropsWithChildren) {
  const api = useManagerWorkspaceApi();
  const realtime = useC7RealtimeClient();
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<RealtimeConnectionStatus>("offline");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seenEventIdsRef = useRef(new Set<string>());

  useEffect(() => {
    let active = true;

    setLoading(true);
    api.notifications
      .list()
      .then((items) => {
        if (active) {
          // Сохраняем realtime-уведомления C7, пришедшие во время загрузки ленты.
          setNotifications((current) => mergeNotificationsById(items, current));
          setError(null);
        }
      })
      .catch((nextError) => {
        if (active) {
          setError(nextError instanceof Error ? nextError.message : "Не удалось загрузить уведомления");
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    const connection = realtime.connect(
      (event) => {
        if (event.event !== "notification.created") {
          return;
        }

        if (!markC7EventSeen(seenEventIdsRef.current, event)) {
          return;
        }

        setNotifications((current) => applyC7EventToNotifications(current, event));
      },
      setConnectionStatus
    );

    return () => {
      connection.close();
    };
  }, [realtime]);

  const markRead = useCallback(
    async (notificationId: string) => {
      setNotifications((current) => markNotificationReadById(current, notificationId));

      try {
        const updated = await api.notifications.markRead(notificationId);
        setNotifications((current) =>
          current.map((notification) =>
            notification.id === updated.id ? { ...notification, ...updated } : notification
          )
        );
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Не удалось отметить прочтение");
        setNotifications((current) =>
          current.map((notification) =>
            notification.id === notificationId
              ? {
                  ...notification,
                  status: "new"
                }
              : notification
          )
        );
      }
    },
    [api]
  );

  const value = useMemo<NotificationsContextValue>(
    () => ({
      notifications,
      unreadCount: countUnreadNotifications(notifications),
      connectionStatus,
      loading,
      error,
      markRead
    }),
    [notifications, connectionStatus, loading, error, markRead]
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications() {
  const value = useContext(NotificationsContext);

  if (!value) {
    throw new Error("Notifications context is not available");
  }

  return value;
}
