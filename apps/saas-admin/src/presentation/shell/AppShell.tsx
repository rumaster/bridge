import {
  Bell,
  BookOpen,
  Building2,
  Cable,
  LayoutDashboard,
  LogOut,
  RadioTower,
  Users,
  Workflow
} from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";

import { useAuth } from "../../state/auth";
import { Badge, Button } from "../../shared/ui-kit";

const navItems = [
  { to: "/overview", label: "Обзор", icon: LayoutDashboard },
  { to: "/organization", label: "Организация", icon: Building2 },
  { to: "/users", label: "Пользователи", icon: Users },
  { to: "/channels", label: "Каналы", icon: Cable },
  { to: "/knowledge", label: "Knowledge Base", icon: BookOpen },
  { to: "/workflow", label: "Workflow", icon: Workflow },
  { to: "/broadcast", label: "Broadcast", icon: RadioTower },
  { to: "/notifications", label: "Уведомления", icon: Bell }
];

export function AppShell() {
  const { logout, session, status } = useAuth();

  return (
    <div className="admin-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">SA</span>
          <span>SaaS Administration</span>
        </div>

        <nav aria-label="Администрирование организации" className="nav-list">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink className="nav-link" key={to} to={to}>
              <Icon aria-hidden="true" size={18} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>

      <main className="workspace-main">
        <header className="topbar">
          <div className="session-summary">
            <Badge tone={status === "authenticated" ? "success" : "neutral"}>
              {status === "authenticated" ? "Администратор" : "Гость"}
            </Badge>
            <span>{session?.organization.name ?? "Организация не выбрана"}</span>
          </div>
          <Button onClick={() => void logout()} type="button" variant="secondary">
            <LogOut aria-hidden="true" size={16} />
            Выйти
          </Button>
        </header>

        <div className="workspace-content">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
