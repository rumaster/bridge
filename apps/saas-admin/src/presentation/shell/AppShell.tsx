import { useState } from "react";
import {
  Bell,
  BookOpen,
  Building2,
  Cable,
  ChevronLeft,
  LayoutDashboard,
  LogOut,
  RadioTower,
  Users,
  Workflow
} from "lucide-react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";

import type { AdminRole } from "../../api/client/types";
import { hasAnyRole, useAuth } from "../../state/auth";
import { Badge, Button } from "../../shared/ui-kit";
import { AiAssistantPanel } from "./AiAssistantPanel";
import type { AiPanelMode } from "./AiAssistantPanel";

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  roles?: AdminRole[];
}

const administratorRoles: AdminRole[] = ["administrator"];
const platformOperatorRoles: AdminRole[] = ["platform_operator"];

const navItems: NavItem[] = [
  { to: "/organization", label: "Организация", icon: Building2, roles: administratorRoles },
  { to: "/users", label: "Пользователи", icon: Users, roles: administratorRoles },
  { to: "/channels", label: "Каналы", icon: Cable, roles: administratorRoles },
  { to: "/knowledge", label: "Knowledge Base", icon: BookOpen, roles: administratorRoles },
  { to: "/workflow", label: "Workflow", icon: Workflow, roles: platformOperatorRoles },
  { to: "/broadcast", label: "Broadcast", icon: RadioTower, roles: administratorRoles },
  { to: "/notifications", label: "Уведомления", icon: Bell, roles: administratorRoles }
];

export function AppShell() {
  const { logout, session, status } = useAuth();
  const location = useLocation();
  const [aiPanelMode, setAiPanelMode] = useState<AiPanelMode>("closed");
  const visibleNavItems = navItems.filter((item) => !item.roles || hasAnyRole(session, item.roles));
  const roleLabel = getRoleLabel(session?.roles[0]);
  // AI-ассистент правит конфигурацию организации — доступен только администратору.
  const canUseAiAssistant = hasAnyRole(session, administratorRoles);
  // Экраны с холстом-редактором (Workflow) занимают всю высоту окна без внутренних
  // отступов рабочей области — верхнее меню освобождает пространство под содержимое.
  const flush = location.pathname.startsWith("/workflow");

  return (
    <div className="admin-shell">
      <a className="skip-link" href="#main-content">
        Перейти к содержимому
      </a>
      <header className="app-topbar" role="banner">
        <Link aria-label="SaaS Administration — на главную" className="brand" to="/">
          <span className="brand-mark">SA</span>
          <span>SaaS Administration</span>
        </Link>

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

        {canUseAiAssistant ? (
          aiPanelMode === "closed" ? (
            <button
              aria-expanded={false}
              aria-label="Открыть панель AI-ассистента"
              className="ai-panel-tab"
              onClick={() => setAiPanelMode("half")}
              title="AI-ассистент"
              type="button"
            >
              <ChevronLeft aria-hidden="true" size={18} />
            </button>
          ) : (
            <>
              {/* Подложка только в широком режиме: в узком контент остаётся рабочим. */}
              {aiPanelMode === "wide" ? (
                <div className="ai-panel-backdrop" onClick={() => setAiPanelMode("closed")} />
              ) : null}
              <AiAssistantPanel mode={aiPanelMode} onModeChange={setAiPanelMode} />
            </>
          )
        ) : null}
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
