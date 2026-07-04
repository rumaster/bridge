import type { PlaywrightTestConfig } from "@playwright/test";

const config: PlaywrightTestConfig = {
  testDir: "./test/e2e",
  webServer: {
    command: "npm run dev -- --port 4319",
    url: "http://127.0.0.1:4319",
    reuseExistingServer: true,
  },
  use: {
    baseURL: "http://127.0.0.1:4319",
  },
};

export default config;
