import type { PlaywrightTestConfig } from "@playwright/test";

const config: PlaywrightTestConfig = {
  testDir: "./test/e2e",
  webServer: {
    command: "VITE_MWS_MOCKS=true npm run dev -- --port 4312",
    url: "http://127.0.0.1:4312",
    reuseExistingServer: true
  },
  use: {
    baseURL: "http://127.0.0.1:4312"
  }
};

export default config;
