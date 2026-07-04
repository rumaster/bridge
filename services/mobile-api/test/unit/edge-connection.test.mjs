import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EDGE_TUNNEL_HEADER,
  EDGE_TUNNEL_HEADER_VALUE,
  resolveMobileEdgeConnection,
} from "../../src/edge-connection.mjs";

describe("SVC-MOB ↔ Edge Cluster — резолвер подключения мобильного клиента (CP-7, §7.6)", () => {
  it("без edgeBaseUrl подключается напрямую, без заголовка туннеля", () => {
    const connection = resolveMobileEdgeConnection({ apiBaseUrl: "/mobile/v1" });

    assert.equal(connection.viaEdge, false);
    assert.equal(connection.apiBaseUrl, "/mobile/v1");
    assert.equal(connection.tunnel, null);
    assert.deepEqual(connection.headers, {});
  });

  it("с edgeBaseUrl маршрутизирует REST через Edge и ставит заголовок туннеля mobile", () => {
    const connection = resolveMobileEdgeConnection({
      apiBaseUrl: "/mobile/v1",
      edgeBaseUrl: "https://edge.rf.bridge.local/mobile/v1",
    });

    assert.equal(connection.viaEdge, true);
    assert.equal(connection.apiBaseUrl, "https://edge.rf.bridge.local/mobile/v1");
    assert.equal(connection.tunnel, EDGE_TUNNEL_HEADER_VALUE);
    assert.equal(EDGE_TUNNEL_HEADER_VALUE, "mobile");
    assert.deepEqual(connection.headers, { [EDGE_TUNNEL_HEADER]: "mobile" });
    assert.equal(EDGE_TUNNEL_HEADER, "x-bridge-edge-tunnel");
  });

  it("пробрасывает realtimeUrl без изменений (у мобильного клиента нет WS-realtime)", () => {
    const direct = resolveMobileEdgeConnection({ realtimeUrl: "https://api.bridge.local/stream" });
    assert.equal(direct.realtimeUrl, "https://api.bridge.local/stream");

    const viaEdge = resolveMobileEdgeConnection({
      realtimeUrl: "https://api.bridge.local/stream",
      edgeBaseUrl: "https://edge.rf.bridge.local/mobile/v1",
    });
    assert.equal(viaEdge.realtimeUrl, "https://api.bridge.local/stream");
  });

  it("пустой/пробельный edgeBaseUrl трактуется как отсутствие Edge", () => {
    for (const edgeBaseUrl of ["", "   ", undefined, null]) {
      const connection = resolveMobileEdgeConnection({ apiBaseUrl: "/mobile/v1", edgeBaseUrl });
      assert.equal(connection.viaEdge, false, `edgeBaseUrl=${JSON.stringify(edgeBaseUrl)}`);
      assert.deepEqual(connection.headers, {});
    }
  });

  it("вызывается без аргументов без падения (значения по умолчанию)", () => {
    const connection = resolveMobileEdgeConnection();
    assert.equal(connection.viaEdge, false);
    assert.equal(connection.apiBaseUrl, undefined);
  });
});
