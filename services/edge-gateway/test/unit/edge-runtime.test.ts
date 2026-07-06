import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createEdgeGatewayRuntimeFromEnv,
  resolveEdgeGatewayMode,
} from "../../src/edge-runtime.js";

const root = join(import.meta.dirname, "../../../..");
const CIPHER_KEY = Buffer.alloc(32, 9).toString("base64");
const SESSION_SECRET = Buffer.alloc(32, 3).toString("base64");

describe("Edge Gateway production runtime wiring (MP-12/MP-22)", () => {
  it("выбирает production-edge режим только при явном EDGE_GATEWAY_MODE=edge", () => {
    assert.equal(resolveEdgeGatewayMode({}), "mock");
    assert.equal(resolveEdgeGatewayMode({ EDGE_GATEWAY_MODE: "mock" }), "mock");
    assert.equal(resolveEdgeGatewayMode({ EDGE_GATEWAY_MODE: "edge" }), "edge");
    assert.equal(resolveEdgeGatewayMode({ EDGE_GATEWAY_MODE: "app-vpn" }), "app-vpn");
  });

  it("production-edge требует RF-секреты, DATABASE_URL и адрес App VPN", async () => {
    await assert.rejects(
      () =>
        createEdgeGatewayRuntimeFromEnv({
          EDGE_GATEWAY_MODE: "edge",
          EDGE_BUFFER_ENCRYPTION_KEY: CIPHER_KEY,
          EDGE_VPN_SESSION_KEY: SESSION_SECRET,
          EDGE_VPN_EDGE_CERT: "edge-rf-cert-fingerprint",
          EDGE_VPN_TRUSTED_APP_CERTS: "app-core-cert-fingerprint",
          EDGE_VPN_APP_TCP_URL: "tcp://app-vpn:3049",
        }),
      /DATABASE_URL/,
    );
  });

  it("RF compose пробрасывает секреты и DATABASE_URL в edge-gateway", () => {
    const compose = readFileSync(
      join(root, "deploy/compose/docker-compose.rf.yml"),
      "utf8",
    );

    assert.match(compose, /EDGE_GATEWAY_MODE:\s*\$\{EDGE_GATEWAY_MODE:-edge\}/);
    assert.match(compose, /DATABASE_URL:\s*\$\{RF_DATABASE_URL/);
    assert.match(compose, /EDGE_BUFFER_ENCRYPTION_KEY:/);
    assert.match(compose, /EDGE_VPN_SESSION_KEY:/);
    assert.match(compose, /EDGE_VPN_APP_TCP_URL:/);
    assert.match(compose, /EDGE_VPN_APP_WSS_URL:/);
    assert.match(compose, /EDGE_VPN_APP_TCP_CLIENT_TLS_CA:/);
    assert.match(compose, /EDGE_VPN_APP_WSS_CLIENT_TLS_CA:/);
  });
});
