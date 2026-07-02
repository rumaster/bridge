import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderWebChatWidget } from "../src/bootstrap";
import {
  DEFAULT_CONVERSATION_ID,
  DEFAULT_ORGANIZATION_ID,
} from "../src/platform/apiClient";

describe("Bridge Web Chat widget", () => {
  it("монтирует виджет в переданную точку", async () => {
    const mountPoint = document.createElement("div");
    document.body.append(mountPoint);

    await renderWebChatWidget(mountPoint, {
      apiBaseUrl: "http://localhost/api/v1",
    });

    expect(
      await within(mountPoint).findByRole("log", { name: "Лента Web Chat" }),
    ).toBeInTheDocument();
  });

  it("рендерит пустую ленту для нового диалога", async () => {
    await renderWebChatWidget(createMountPoint(), {
      apiBaseUrl: "http://localhost/api/v1",
      conversationId: DEFAULT_CONVERSATION_ID,
    });

    expect(await screen.findByText("Пока нет сообщений")).toBeInTheDocument();
  });

  it("рендерит поле ввода сообщения", async () => {
    await renderWebChatWidget(createMountPoint(), {
      apiBaseUrl: "http://localhost/api/v1",
    });

    expect(await screen.findByLabelText("Сообщение")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Отправить" }),
    ).toBeDisabled();
  });

  it("отправляет сообщение через мок C3.messages и добавляет его в ленту", async () => {
    const user = userEvent.setup();
    await renderWebChatWidget(createMountPoint(), {
      apiBaseUrl: "http://localhost/api/v1",
      conversationId: DEFAULT_CONVERSATION_ID,
      organizationId: DEFAULT_ORGANIZATION_ID,
    });

    await user.type(await screen.findByLabelText("Сообщение"), "Здравствуйте");
    await user.click(screen.getByRole("button", { name: "Отправить" }));

    expect(await screen.findByText("Здравствуйте")).toBeInTheDocument();
    expect(screen.getByLabelText("Сообщение")).toHaveValue("");
  });
});

function createMountPoint() {
  const mountPoint = document.createElement("div");
  document.body.append(mountPoint);
  return mountPoint;
}
