import { RouterProvider } from "react-router-dom";

import { createSaasAdminRouter } from "./routing/router";

export function App() {
  return <RouterProvider router={createSaasAdminRouter()} />;
}
