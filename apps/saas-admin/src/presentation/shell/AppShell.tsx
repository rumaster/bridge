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

import type { AdminRole } from "../../api/client/types";
import { hasAnyRole, useAuth } from "../../state/auth";
import { Badge, Button } from "../../shared/ui-kit";

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  roles?: AdminRole[];
}

const administratorRoles: AdminRole[] = ["administrator"];

const navItems: NavItem[] = [
  { to: "/overview", label: "Обзор", icon: LayoutDashboard },
  { to: "/organization", label: "Организация", icon: Building2, roles: administratorRoles },
  { to: "/users", label: "Пользователи", icon: Users, roles: administratorRoles },
  { to: "/channels", label: "Каналы", icon: Cable, roles: administratorRoles },
  { to: "/knowledge", label: "Knowledge Base", icon: BookOpen, roles: administratorRoles },
  { to: "/workflow", label: "Workflow", icon: Workflow, roles: administratorRoles },
  { to: "/broadcast", label: "Broadcast", icon: RadioTower, roles: administratorRoles },
  { to: "/notifications", label: "Уведомления", icon: Bell, roles: administratorRoles }
];

export function AppShell() {
  const { logout, session, status } = useAuth();
  const visibleNavItems = navItems.filter((item) => !item.roles || hasAnyRole(session, item.roles));
  const roleLabel = getRoleLabel(session?.roles[0]);

  return (
    <div className="admin-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">SA</span>
          <span>SaaS Administration</span>
        </div>

        <nav aria-label="Администрирование организации" className="nav-list">
          {visibleNavItems.map(({ to, label, icon: Icon }) => (
            <NavLink className="nav-link" key={to} to={to}>
              <Icon aria-hidden="true" size={18} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>

      <main className="workspace-main">
        <header className="topbar" role="banner">
          <div className="session-summary">
            <Badge tone={status === "authenticated" ? "success" : "neutral"}>
              {status === "authenticated" ? roleLabel : "Гость"}
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

function getRoleLabel(role: AdminRole | undefined) {
  switch (role) {
    case "administrator":
      return "Администратор";
    case "manager":
      return "Менеджер";
    case "platform_operator":
      return "Оператор";
    default:
      return "Гость";
  }
}
