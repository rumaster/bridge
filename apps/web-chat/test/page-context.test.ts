import { describe, expect, it } from "vitest";

import { resolveWebChatPageParams } from "../src/platform/pageContext";

/**
 * Разбор организации из URL хостируемой страницы (W5, WG-1/WG-2,
 * docs/plan/web-chat-channel-production.md).
 */
describe("resolveWebChatPageParams", () => {
  it("берёт organizationId из пути /chat/<id>", () => {
    expect(resolveWebChatPageParams({ pathname: "/chat/org-123", search: "" })).toEqual({
      organizationId: "org-123",
    });
  });

  it("берёт organizationId из query (organization_id | org)", () => {
    expect(resolveWebChatPageParams({ pathname: "/", search: "?organization_id=org-9" })).toEqual({
      organizationId: "org-9",
    });
    expect(resolveWebChatPageParams({ pathname: "/", search: "?org=org-x" })).toEqual({
      organizationId: "org-x",
    });
  });

  it("путь имеет приоритет над query", () => {
    expect(
      resolveWebChatPageParams({
        pathname: "/chat/from-path",
        search: "?organization_id=from-query",
      }).organizationId,
    ).toBe("from-path");
  });

  it("берёт conversationId из query", () => {
    expect(
      resolveWebChatPageParams({ pathname: "/chat/o", search: "?conversation_id=c-1" }),
    ).toEqual({ organizationId: "o", conversationId: "c-1" });
  });

  it("декодирует и обрезает хвост пути после id", () => {
    expect(
      resolveWebChatPageParams({
        pathname: "/chat/22345678-1234-4234-8234-123456789abc/extra",
      }).organizationId,
    ).toBe("22345678-1234-4234-8234-123456789abc");
    expect(resolveWebChatPageParams({ pathname: "/chat/org%20a" }).organizationId).toBe("org a");
  });

  it("пусто, если организации нет ни в пути, ни в query", () => {
    expect(resolveWebChatPageParams({ pathname: "/", search: "" })).toEqual({});
    expect(resolveWebChatPageParams({})).toEqual({});
  });
});
