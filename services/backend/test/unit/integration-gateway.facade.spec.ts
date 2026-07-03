import { IntegrationGatewayFacade } from "../../src/modules/integration-gateway/integration-gateway.facade";

const fixedNow = () => "2026-07-03T09:00:00.000Z";

describe("IntegrationGatewayFacade", () => {
  it("connects a Web Chat channel using credentials_ref and publishes C6 capabilities", () => {
    const facade = new IntegrationGatewayFacade(fixedNow);

    const channel = facade.connectChannel({
      organization_id: "org-1",
      channel_type: "web_chat",
      name: "Основной Web Chat",
      credentials_ref: "secret://web-chat/org-1/main",
      config: {
        widget_origin: "https://example.test",
      },
    });

    expect(channel).toMatchObject({
      organization_id: "org-1",
      channel_type: "web_chat",
      name: "Основной Web Chat",
      status: "connected",
      credentials_ref: "secret://web-chat/org-1/main",
      created_at: "2026-07-03T09:00:00.000Z",
      updated_at: "2026-07-03T09:00:00.000Z",
    });
    expect(channel).not.toHaveProperty("token");

    const capabilities = facade.getChannelCapabilities(channel.id);
    expect(capabilities.channel_id).toBe(channel.id);
    expect(capabilities.capabilities.text.supported).toBe(true);
    expect(capabilities.capabilities.image.supported).toBe(true);
    expect(capabilities.capabilities.file.supported).toBe(true);
    expect(capabilities.capabilities.typing_indicator.supported).toBe(true);
    expect(capabilities.capabilities.read_receipt.supported).toBe(true);
    expect(capabilities.capabilities.voice.supported).toBe(false);
  });

  it.each([
    ["telegram", "telegram-adapter", "secret://telegram/org-1/main", true, false],
    ["email", "email-adapter", "secret://email/org-1/support", false, false],
    ["sms", "sms-adapter", "secret://sms/org-1/main", false, false],
    ["vk", "vk-adapter", "secret://vk/org-1/main", true, false],
    ["max", "max-adapter", "secret://max/org-1/main", true, false],
    ["whatsapp", "whatsapp-adapter", "secret://whatsapp/org-1/main", false, true],
  ] as const)(
    "connects %s using credentials_ref and returns channel-specific C6",
    (channelType, adapterName, credentialsRef, typingIndicator, readReceipt) => {
      const facade = new IntegrationGatewayFacade(fixedNow);

      const channel = facade.connectChannel({
        organization_id: "org-1",
        channel_type: channelType,
        name: `${channelType} main`,
        credentials_ref: credentialsRef,
        config: {
          endpoint: `${channelType}-endpoint`,
        },
      });

      expect(channel).toMatchObject({
        organization_id: "org-1",
        channel_type: channelType,
        credentials_ref: credentialsRef,
        status: "connected",
      });
      expect(channel).not.toHaveProperty("token");

      const capabilities = facade.getChannelCapabilities(channel.id, "org-1");
      expect(capabilities.channel_type).toBe(channelType);
      expect(capabilities.channel_id).toBe(channel.id);
      expect(capabilities.adapter.name).toBe(adapterName);
      expect(capabilities.capabilities.text.supported).toBe(true);
      expect(capabilities.capabilities.typing_indicator.supported).toBe(typingIndicator);
      expect(capabilities.capabilities.read_receipt.supported).toBe(readReceipt);
    },
  );
});
