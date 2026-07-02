import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./presentation/styles.css";

async function enableMocks() {
  if (import.meta.env.DEV && import.meta.env.VITE_SAAS_ADMIN_MOCKS === "true") {
    const { worker } = await import("./api/mocks/browser");
    await worker.start({ onUnhandledRequest: "bypass", quiet: true });
  }
}

enableMocks().then(() => {
  const root = document.getElementById("root");

  if (!root) {
    throw new Error("Root element #root is missing");
  }

  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
});
