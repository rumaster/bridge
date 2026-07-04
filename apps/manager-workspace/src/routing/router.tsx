import { Suspense, lazy } from "react";
import {
  Navigate,
  Outlet,
  createBrowserRouter,
  createMemoryRouter
} from "react-router-dom";
import type { RouteObject } from "react-router-dom";

import { AppShell } from "../presentation/shell/AppShell";
import { NotificationsProvider } from "../state/notifications";
import { ManagerWorkspaceProviders } from "../state/workspace";
import type { ManagerWorkspaceServices } from "../state/workspace";

const LoginPage = lazy(() => import("../presentation/pages/LoginPage"));
const QueuePage = lazy(() => import("../presentation/pages/QueuePage"));
const DialogPage = lazy(() => import("../presentation/pages/DialogPage"));
const NotificationsPage = lazy(() => import("../presentation/pages/NotificationsPage"));

export interface CreateManagerWorkspaceRouterOptions {
  initialEntries?: string[];
  services?: ManagerWorkspaceServices;
}

export function createManagerWorkspaceRouter(options: CreateManagerWorkspaceRouterOptions = {}) {
  const routes = createRoutes(options.services);

  if (options.initialEntries) {
    return createMemoryRouter(routes, {
      initialEntries: options.initialEntries
    });
  }

  return createBrowserRouter(routes);
}

function createRoutes(services?: ManagerWorkspaceServices): RouteObject[] {
  return [
    {
      element: (
        <ManagerWorkspaceProviders services={services}>
          <Suspense fallback={<div className="route-loader">Загрузка раздела...</div>}>
            <Outlet />
          </Suspense>
        </ManagerWorkspaceProviders>
      ),
      children: [
        {
          index: true,
          element: <Navigate to="/queue" replace />
        },
        {
          path: "login",
          element: <LoginPage />
        },
        {
          element: (
            <NotificationsProvider>
              <AppShell />
            </NotificationsProvider>
          ),
          children: [
            {
              path: "queue",
              element: <QueuePage />
            },
            {
              path: "dialogs/:conversationId",
              element: <DialogPage />
            },
            {
              path: "notifications",
              element: <NotificationsPage />
            }
          ]
        },
        {
          path: "*",
          element: <Navigate to="/queue" replace />
        }
      ]
    }
  ];
}
