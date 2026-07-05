import { readFileSync } from "node:fs";

export const MOBILE_API_PREVIOUS_VERSION = "1.0.0";
export const MOBILE_API_VERSION = "1.1.0";
export const MOBILE_API_SUPPORTED_VERSIONS = Object.freeze([
  MOBILE_API_PREVIOUS_VERSION,
  MOBILE_API_VERSION,
]);
export const MOBILE_API_BASE_PATH = "/mobile/v1";
export const MOBILE_API_CONTRACT_ID = "MOBILE.v1";
export const MOBILE_SYNC_CURSOR_PREFIX = "mob1";

export const MOBILE_API_OPENAPI = Object.freeze(
  JSON.parse(
    readFileSync(
      new URL("../openapi/mobile/mobile.v1.openapi.json", import.meta.url),
      "utf8",
    ),
  ),
);

export const MOBILE_CONSUMER_CONTRACTS = Object.freeze(
  JSON.parse(
    readFileSync(
      new URL("../mobile/consumer-contracts.v1.json", import.meta.url),
      "utf8",
    ),
  ),
);

export function isMobileSyncCursor(value) {
  return (
    typeof value === "string" &&
    new RegExp(`^${MOBILE_SYNC_CURSOR_PREFIX}\\.[A-Za-z0-9_-]+$`).test(value)
  );
}

export function isSupportedMobileApiVersion(value) {
  return MOBILE_API_SUPPORTED_VERSIONS.includes(value);
}
