import { RouterProvider } from "react-router-dom";

import { createManagerWorkspaceRouter } from "./routing/router";

export function App() {
  return <RouterProvider router={createManagerWorkspaceRouter()} />;
}
