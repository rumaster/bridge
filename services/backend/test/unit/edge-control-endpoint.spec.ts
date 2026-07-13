import {
  resolveEdgeControlEndpoint,
  resolveEdgeControlUrl,
} from "../../src/common/edge-control/edge-control-endpoint";

describe("resolveEdgeControlEndpoint (App→Edge control-plane target, MP-12)", () => {
  it("отдаёт туннельный релей приоритетнее прямого HTTP", () => {
    const resolved = resolveEdgeControlEndpoint({
      EDGE_CONTROL_URL: "http://edge:3000/internal/edge/control/messages",
      EDGE_CONTROL_TUNNEL_URL: "http://edge-vpn-app:3052/internal/edge/control/relay",
    } as NodeJS.ProcessEnv);
    expect(resolved).toEqual({
      url: "http://edge-vpn-app:3052/internal/edge/control/relay",
      viaTunnel: true,
    });
  });

  it("падает на прямой HTTP, если туннельный URL не задан (одно-хостовый стенд)", () => {
    const resolved = resolveEdgeControlEndpoint({
      EDGE_CONTROL_URL: "http://edge:3000/internal/edge/control/messages",
    } as NodeJS.ProcessEnv);
    expect(resolved).toEqual({
      url: "http://edge:3000/internal/edge/control/messages",
      viaTunnel: false,
    });
  });

  it("возвращает null, если ни один адрес не настроен", () => {
    expect(resolveEdgeControlEndpoint({} as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveEdgeControlUrl({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("игнорирует пробельные значения", () => {
    expect(
      resolveEdgeControlEndpoint({
        EDGE_CONTROL_TUNNEL_URL: "   ",
        EDGE_CONTROL_URL: "  http://edge:3000/x  ",
      } as NodeJS.ProcessEnv),
    ).toEqual({ url: "http://edge:3000/x", viaTunnel: false });
  });
});
