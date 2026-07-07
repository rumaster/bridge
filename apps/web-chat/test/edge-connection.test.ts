import { describe, expect, it } from "vitest";
import {
  EDGE_TUNNEL_HEADER,
  EDGE_TUNNEL_HEADER_VALUE,
  resolveEdgeConnection,
} from "../src/platform/edgeConnection";

describe("Bridge Web Chat Edge connection (CP-7)", () => {
  it("по умолчанию маршрутизирует Web Chat через Edge на той же origin-базе", () => {
    const connection = resolveEdgeConnection({
      apiBaseUrl: "https://app.bridge/api/v1",
    });

    expect(connection.viaEdge).toBe(true);
    expect(connection.apiBaseUrl).toBe("https://app.bridge/api/v1");
    expect(connection.realtimeUrl).toBe("wss://app.bridge/api/v1/ws");
    expect(connection.headers[EDGE_TUNNEL_HEADER]).toBe(EDGE_TUNNEL_HEADER_VALUE);
  });

  it("явный direct mode оставлен только для dev/test-обвязок", () => {
    const connection = resolveEdgeConnection({
      apiBaseUrl: "https://app.bridge/api/v1",
      requireEdge: false,
    });

    expect(connection.viaEdge).toBe(false);
    expect(connection.headers).toEqual({});
  });

  it("с edgeBaseUrl прозрачно маршрутизирует REST/WS через Edge", () => {
    const connection = resolveEdgeConnection({
      apiBaseUrl: "https://app.bridge/api/v1",
      edgeBaseUrl: "https://edge.rf.bridge/api/v1",
    });

    expect(connection.viaEdge).toBe(true);
    expect(connection.apiBaseUrl).toBe("https://edge.rf.bridge/api/v1");
    expect(connection.realtimeUrl).toBe("wss://edge.rf.bridge/api/v1/ws");
    expect(connection.headers[EDGE_TUNNEL_HEADER]).toBe(EDGE_TUNNEL_HEADER_VALUE);
  });

  it("уважает явный realtimeUrl даже при маршрутизации через Edge", () => {
    const connection = resolveEdgeConnection({
      apiBaseUrl: "https://app.bridge/api/v1",
      edgeBaseUrl: "https://edge.rf.bridge/api/v1",
      realtimeUrl: "wss://edge.rf.bridge/tunnel",
    });

    expect(connection.realtimeUrl).toBe("wss://edge.rf.bridge/tunnel");
  });
});
