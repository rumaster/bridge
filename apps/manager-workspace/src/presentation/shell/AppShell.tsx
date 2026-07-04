import { Bell, Inbox, LogIn, LogOut, MessageSquare } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";

import { useAuth } from "../../state/auth";
import { useNotifications } from "../../state/notifications";
import { Badge, Button } from "../../shared/ui-kit";

const navItems = [
  { to: "/queue", label: "Очередь", icon: Inbox },
  { to: "/dialogs/conv-1", label: "Диалог", icon: MessageSquare },
  { to: "/notifications", label: "Уведомления", icon: Bell, showUnread: true }
];

export function AppShell() {
  const { logout, session, status } = useAuth();
  const { unreadCount } = useNotifications();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">MW</span>
          <span>Manager Workspace</span>
        </div>

        <nav aria-label="Рабочее место менеджера" className="nav-list">
          {navItems.map(({ to, label, icon: Icon, showUnread }) => (
            <NavLink className="nav-link" key={to} to={to}>
              <Icon aria-hidden="true" size={18} />
              <span>{label}</span>
              {showUnread && unreadCount > 0 ? (
                <span
                  aria-label={`Непрочитанных уведомлений: ${unreadCount}`}
                  className="nav-badge"
                >
                  {unreadCount}
                </span>
              ) : null}
            </NavLink>
          ))}
        </nav>
      </aside>

      <main className="workspace-main">
        <header className="topbar">
          <div className="session-summary">
            <Badge tone={status === "authenticated" ? "success" : "neutral"}>
              {status === "loading" ? "Проверка сессии" : status === "authenticated" ? "Сессия" : "Гость"}
            </Badge>
            <span>{session?.user.displayName ?? "Вход не выполнен"}</span>
          </div>
          {status === "authenticated" ? (
            <Button onClick={logout} type="button" variant="secondary">
              <LogOut aria-hidden="true" size={16} />
              Выйти
            </Button>
          ) : (
            <Button asLink to="/login" variant="secondary">
              <LogIn aria-hidden="true" size={16} />
              Вход
            </Button>
          )}
        </header>

        <div className="workspace-content">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
