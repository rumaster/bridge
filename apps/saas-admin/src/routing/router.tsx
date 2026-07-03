import { Suspense, lazy } from "react";
import {
  Navigate,
  Outlet,
  createBrowserRouter,
  createMemoryRouter,
  useLocation
} from "react-router-dom";
import type { Location, RouteObject } from "react-router-dom";

import { AppShell } from "../presentation/shell/AppShell";
import { useAuth } from "../state/auth";
import { SaasAdminProviders } from "../state/admin";
import type { SaasAdminServiceOverrides } from "../state/admin";

const LoginPage = lazy(() => import("../presentation/pages/LoginPage"));
const OverviewPage = lazy(() => import("../presentation/pages/OverviewPage"));
const OrganizationPage = lazy(() => import("../presentation/pages/OrganizationPage"));
const UsersPage = lazy(() => import("../presentation/pages/UsersPage"));
const ChannelsPage = lazy(() => import("../presentation/pages/ChannelsPage"));
const KnowledgePage = lazy(() => import("../presentation/pages/KnowledgePage"));
const WorkflowPage = lazy(() => import("../presentation/pages/WorkflowPage"));
const OnboardingPage = lazy(() => import("../presentation/pages/OnboardingPage"));
const BroadcastPage = lazy(() => import("../presentation/pages/BroadcastPage"));
const NotificationsPage = lazy(() => import("../presentation/pages/NotificationsPage"));

export interface CreateSaasAdminRouterOptions {
  initialEntries?: string[];
  services?: SaasAdminServiceOverrides;
}

export interface LoginLocationState {
  from?: Location;
}

export function createSaasAdminRouter(options: CreateSaasAdminRouterOptions = {}) {
  const routes = createRoutes(options.services);

  if (options.initialEntries) {
    return createMemoryRouter(routes, {
      initialEntries: options.initialEntries
    });
  }

  return createBrowserRouter(routes);
}

function createRoutes(services?: SaasAdminServiceOverrides): RouteObject[] {
  return [
    {
      element: (
        <SaasAdminProviders services={services}>
          <Suspense fallback={<div className="route-loader">Загрузка раздела...</div>}>
            <Outlet />
          </Suspense>
        </SaasAdminProviders>
      ),
      children: [
        {
          index: true,
          element: <Navigate to="/overview" replace />
        },
        {
          path: "login",
          element: <LoginPage />
        },
        {
          element: <ProtectedRoute />,
          children: [
            {
              element: <AppShell />,
              children: [
                {
                  path: "overview",
                  element: <OverviewPage />
                },
                {
                  path: "organization",
                  element: <OrganizationPage />
                },
                {
                  path: "users",
                  element: <UsersPage />
                },
                {
                  path: "channels",
                  element: <ChannelsPage />
                },
                {
                  path: "knowledge",
                  element: <KnowledgePage />
                },
                {
                  path: "workflow",
                  element: <WorkflowPage />
                },
                {
                  path: "onboarding",
                  element: <OnboardingPage />
                },
                {
                  path: "broadcast",
                  element: <BroadcastPage />
                },
                {
                  path: "notifications",
                  element: <NotificationsPage />
                }
              ]
            }
          ]
        },
        {
          path: "*",
          element: <Navigate to="/overview" replace />
        }
      ]
    }
  ];
}

function ProtectedRoute() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return <div className="route-loader">Проверка сессии...</div>;
  }

  if (status === "anonymous") {
    return <Navigate replace state={{ from: location }} to="/login" />;
  }

  return <Outlet />;
}
