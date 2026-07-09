import {
  Bell,
  BookOpen,
  Building2,
  Cable,
  LayoutDashboard,
  LogOut,
  RadioTower,
  Sparkles,
  Users,
  Workflow
} from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

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
const platformOperatorRoles: AdminRole[] = ["platform_operator"];

const navItems: NavItem[] = [
  { to: "/overview", label: "Обзор", icon: LayoutDashboard },
  { to: "/organization", label: "Организация", icon: Building2, roles: administratorRoles },
  { to: "/users", label: "Пользователи", icon: Users, roles: administratorRoles },
  { to: "/channels", label: "Каналы", icon: Cable, roles: administratorRoles },
  { to: "/knowledge", label: "Knowledge Base", icon: BookOpen, roles: administratorRoles },
  { to: "/workflow", label: "Workflow", icon: Workflow, roles: platformOperatorRoles },
  { to: "/onboarding", label: "AI Onboarding", icon: Sparkles, roles: administratorRoles },
  { to: "/broadcast", label: "Broadcast", icon: RadioTower, roles: administratorRoles },
  { to: "/notifications", label: "Уведомления", icon: Bell, roles: administratorRoles }
];

export function AppShell() {
  const { logout, session, status } = useAuth();
  const location = useLocation();
  const visibleNavItems = navItems.filter((item) => !item.roles || hasAnyRole(session, item.roles));
  const roleLabel = getRoleLabel(session?.roles[0]);
  // Экраны с холстом-редактором (Workflow) занимают всю высоту окна без внутренних
  // отступов рабочей области — верхнее меню освобождает пространство под содержимое.
  const flush = location.pathname.startsWith("/workflow");

  return (
    <div className="admin-shell">
      <a className="skip-link" href="#main-content">
        Перейти к содержимому
      </a>
      <header className="app-topbar" role="banner">
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

        <div className="app-topbar-session">
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
        </div>
      </header>

      <main className="workspace-main">
        <div
          className={`workspace-content ${flush ? "workspace-content--flush" : ""}`}
          id="main-content"
          tabIndex={-1}
        >
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
