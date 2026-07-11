import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { createMockC7RealtimeClient } from "../src/api/client/realtime";
import { createMockSaasAdminApiClient, createMockSaasAdminServices } from "../src/api/mocks/client";
import { mockSession } from "../src/api/mocks/fixtures";
import { createSaasAdminRouter } from "../src/routing/router";
import type { C7Event } from "../src/api/client/types";
import type { SaasAdminServiceOverrides } from "../src/state/admin";

function renderRoute(path: string, services: SaasAdminServiceOverrides = createMockSaasAdminServices()) {
  const router = createSaasAdminRouter({
    initialEntries: [path],
    services
  });

  return {
    user: userEvent.setup(),
    ...render(<RouterProvider router={router} />)
  };
}

describe("SaaS Administration M2 channels and Knowledge Base", () => {
  it("renders C3.channels cards, tests a connection and applies C7 realtime status updates", async () => {
    const api = createMockSaasAdminApiClient();
    const testChannel = vi.spyOn(api.channels, "testChannel");
    const realtimeEvent: C7Event = {
      type: "channel.status_changed",
      sequenceNumber: 1,
      payload: {
        channelId: "channel-telegram-main",
        status: "connected",
        lastCheckAt: "2026-07-03T10:14:00.000Z"
      }
    };

    const { user } = renderRoute("/channels", {
      api,
      realtime: createMockC7RealtimeClient([realtimeEvent])
    });

    const telegramCard = await screen.findByRole("article", { name: /Telegram Support/ });
    expect(within(telegramCard).getByText("WEBHOOK_TIMEOUT")).toBeInTheDocument();

    await waitFor(() => {
      expect(within(telegramCard).getByText("Подключен")).toBeInTheDocument();
    });

    const webChatCard = screen.getByRole("article", { name: /Основной Web Chat/ });
    expect(within(webChatCard).getByText("secret://web-chat/org-demo/main")).toBeInTheDocument();
    expect(screen.queryByText(/bot-token|access_token/i)).not.toBeInTheDocument();
    expect(within(webChatCard).getByText("text")).toBeInTheDocument();
    expect(within(webChatCard).getByText("read_receipt")).toBeInTheDocument();

    await user.click(within(webChatCard).getByRole("button", { name: "Проверить подключение" }));

    expect(await within(webChatCard).findByText("Проверка подключения выполнена")).toBeInTheDocument();
    expect(testChannel).toHaveBeenCalledWith("channel-web-chat-main");
  });

  it("connects a channel using credentials_ref and renders validation errors from the form", async () => {
    const api = createMockSaasAdminApiClient();
    const createChannel = vi.spyOn(api.channels, "createChannel");
    const { user } = renderRoute("/channels", { api, realtime: createMockC7RealtimeClient([]) });

    await screen.findByRole("heading", { name: "Каналы связи" });
    await user.click(screen.getByRole("button", { name: "Подключить канал" }));

    expect(await screen.findByText("Название канала обязательно.")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Название канала"), "Витрина Web Chat");
    await user.type(screen.getByLabelText("credentials_ref"), "secret://web-chat/org-demo/storefront");
    await user.type(screen.getByLabelText("Widget origin"), "https://storefront.example.test");
    await user.click(screen.getByRole("button", { name: "Подключить канал" }));

    expect(await screen.findByRole("article", { name: /Витрина Web Chat/ })).toBeInTheDocument();
    expect(createChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: mockSession.organization.id,
        channel_type: "web_chat",
        name: "Витрина Web Chat",
        credentials_ref: "secret://web-chat/org-demo/storefront",
        config: {
          widget_origin: "https://storefront.example.test"
        }
      })
    );
  });

  it.each([
    {
      channelLabel: "Telegram",
      channelType: "telegram",
      config: { bot_username: "bridge_support_bot" },
      configLabel: "Bot username",
      configValue: "bridge_support_bot",
      secretLabel: "Токен бота",
      secretValue: "123456789:AAEEuMlqL7f4t2Qb9cVvZ0xYw1sRtUvWxYz",
      expectedSecret: { credentials: "123456789:AAEEuMlqL7f4t2Qb9cVvZ0xYw1sRtUvWxYz" },
      name: "Telegram Sales"
    },
    {
      channelLabel: "MAX",
      channelType: "max",
      config: { endpoint: "max-support-bot" },
      configLabel: "Endpoint",
      configValue: "max-support-bot",
      secretLabel: "credentials_ref",
      secretValue: "secret://max/org-demo/support-bot",
      expectedSecret: { credentials_ref: "secret://max/org-demo/support-bot" },
      name: "MAX Support"
    }
  ] as const)(
    "connects $channelLabel from the channels page",
    async ({
      channelLabel,
      channelType,
      config,
      configLabel,
      configValue,
      secretLabel,
      secretValue,
      expectedSecret,
      name
    }) => {
      const api = createMockSaasAdminApiClient();
      const createChannel = vi.spyOn(api.channels, "createChannel");
      const { user } = renderRoute("/channels", { api, realtime: createMockC7RealtimeClient([]) });

      await screen.findByRole("heading", { name: "Каналы связи" });
      await user.click(screen.getByRole("radio", { name: channelLabel }));
      await user.type(screen.getByLabelText("Название канала"), name);
      await user.type(screen.getByLabelText(secretLabel), secretValue);
      await user.type(screen.getByLabelText(configLabel), configValue);
      await user.click(screen.getByRole("button", { name: "Подключить канал" }));

      expect(await screen.findByRole("article", { name: new RegExp(name) })).toBeInTheDocument();
      expect(createChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: mockSession.organization.id,
          channel_type: channelType,
          name,
          ...expectedSecret,
          config
        })
      );
    }
  );

  it("connects Email with structured IMAP/SMTP credentials from the channels page (E1)", async () => {
    const api = createMockSaasAdminApiClient();
    const createChannel = vi.spyOn(api.channels, "createChannel");
    const { user } = renderRoute("/channels", { api, realtime: createMockC7RealtimeClient([]) });

    await screen.findByRole("heading", { name: "Каналы связи" });
    await user.click(screen.getByRole("radio", { name: "Email" }));
    await user.type(screen.getByLabelText("Название канала"), "Email Support");

    await user.type(screen.getByLabelText("IMAP хост"), "imap.example.com");
    await user.clear(screen.getByLabelText("IMAP порт"));
    await user.type(screen.getByLabelText("IMAP порт"), "993");
    await user.type(screen.getByLabelText("IMAP логин"), "support@example.com");
    await user.type(screen.getByLabelText("IMAP пароль"), "imap-secret");

    await user.type(screen.getByLabelText("SMTP хост"), "smtp.example.com");
    await user.clear(screen.getByLabelText("SMTP порт"));
    await user.type(screen.getByLabelText("SMTP порт"), "587");
    await user.type(screen.getByLabelText("SMTP логин"), "support@example.com");
    await user.type(screen.getByLabelText("SMTP пароль"), "smtp-secret");

    await user.type(screen.getByLabelText("From email"), "support@example.com");
    await user.type(screen.getByLabelText("Имя отправителя"), "Служба поддержки");

    await user.click(screen.getByRole("button", { name: "Подключить канал" }));

    expect(await screen.findByRole("article", { name: /Email Support/ })).toBeInTheDocument();
    expect(createChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: mockSession.organization.id,
        channel_type: "email",
        name: "Email Support",
        email_credentials: {
          imap: { host: "imap.example.com", port: 993, tls: true, username: "support@example.com", password: "imap-secret" },
          smtp: { host: "smtp.example.com", port: 587, tls: true, username: "support@example.com", password: "smtp-secret" },
          from_email: "support@example.com",
          from_name: "Служба поддержки"
        },
        config: {}
      })
    );
    // Секрет не вводится как credentials_ref и не показывается после сохранения.
    expect(createChannel.mock.calls[0][0]).not.toHaveProperty("credentials_ref");
  });

  it("validates required IMAP/SMTP fields before connecting Email (E1)", async () => {
    const api = createMockSaasAdminApiClient();
    const createChannel = vi.spyOn(api.channels, "createChannel");
    const { user } = renderRoute("/channels", { api, realtime: createMockC7RealtimeClient([]) });

    await screen.findByRole("heading", { name: "Каналы связи" });
    await user.click(screen.getByRole("radio", { name: "Email" }));
    await user.type(screen.getByLabelText("Название канала"), "Email Support");
    await user.click(screen.getByRole("button", { name: "Подключить канал" }));

    expect(await screen.findByText("IMAP хост обязателен.")).toBeInTheDocument();
    expect(screen.getByText("From email должен быть адресом email.")).toBeInTheDocument();
    expect(createChannel).not.toHaveBeenCalled();
  });

  it("uploads, updates, reindexes and deletes Knowledge Base documents", async () => {
    const api = createMockSaasAdminApiClient();
    const createDocument = vi.spyOn(api.knowledge, "createDocument");
    const updateDocument = vi.spyOn(api.knowledge, "updateDocument");
    const reindexDocument = vi.spyOn(api.knowledge, "reindexDocument");
    const deleteDocument = vi.spyOn(api.knowledge, "deleteDocument");
    const { user } = renderRoute("/knowledge", { api, realtime: createMockC7RealtimeClient([]) });

    expect(await screen.findByRole("article", { name: /FAQ возвратов/ })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Название документа"), "Политика гарантий");
    await user.type(screen.getByLabelText("Источник"), "manual://warranty");
    await user.upload(
      screen.getByLabelText("Файл документа"),
      new File(["Гарантийные правила"], "warranty.md", { type: "text/markdown" })
    );
    await user.click(screen.getByRole("button", { name: "Загрузить документ" }));

    expect(await screen.findByRole("article", { name: /Политика гарантий/ })).toBeInTheDocument();
    expect(createDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: mockSession.organization.id,
        title: "Политика гарантий",
        source: "manual://warranty",
        file_name: "warranty.md"
      })
    );

    const faqCard = screen.getByRole("article", { name: /FAQ возвратов/ });
    const faqTitle = within(faqCard).getByLabelText("Название в KB");
    await user.clear(faqTitle);
    await user.type(faqTitle, "FAQ возвратов v2");
    await user.click(within(faqCard).getByRole("button", { name: "Сохранить документ" }));

    expect(await screen.findByRole("article", { name: /FAQ возвратов v2/ })).toBeInTheDocument();
    expect(updateDocument).toHaveBeenCalledWith(
      "kb-doc-returns",
      expect.objectContaining({ title: "FAQ возвратов v2" })
    );

    const updatedFaqCard = screen.getByRole("article", { name: /FAQ возвратов v2/ });
    await user.click(within(updatedFaqCard).getByRole("button", { name: "Переиндексировать" }));
    expect(await within(updatedFaqCard).findByLabelText("Индексация FAQ возвратов v2")).toBeInTheDocument();
    expect(reindexDocument).toHaveBeenCalledWith("kb-doc-returns");

    const failedCard = screen.getByRole("article", { name: /Прайс-лист/ });
    await user.click(within(failedCard).getByRole("button", { name: "Удалить документ" }));

    await waitFor(() => {
      expect(screen.queryByRole("article", { name: /Прайс-лист/ })).not.toBeInTheDocument();
    });
    expect(deleteDocument).toHaveBeenCalledWith("kb-doc-prices");
  });
});
