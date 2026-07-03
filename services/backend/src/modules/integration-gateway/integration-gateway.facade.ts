import { randomUUID } from "node:crypto";

import { Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";

import type { FacadeStatusDto } from "../ai-integration/ai-integration.facade";

export const INTEGRATION_GATEWAY_CLOCK = Symbol("INTEGRATION_GATEWAY_CLOCK");

export type ChannelStatus = "connected" | "error" | "disabled";
export type ChannelType =
  | "web_chat"
  | "telegram"
  | "email"
  | "sms"
  | "vk"
  | "max"
  | "whatsapp";
export type CapabilityName =
  | "text"
  | "image"
  | "file"
  | "voice"
  | "video"
  | "buttons"
  | "reactions"
  | "typing_indicator"
  | "read_receipt"
  | "delete"
  | "edit";

export interface ChannelFacade {
  id: string;
  organization_id: string;
  channel_type: ChannelType;
  name: string;
  status: ChannelStatus;
  credentials_ref?: string;
  config: Record<string, unknown>;
  last_check_at?: string;
  created_at: string;
  updated_at: string;
}

export interface ConnectWebChatChannelRequest {
  organization_id: string;
  channel_type?: "web_chat";
  name: string;
  credentials_ref?: string;
  config?: Record<string, unknown>;
}

export interface ConnectChannelRequest {
  organization_id: string;
  channel_type: ChannelType;
  name: string;
  credentials_ref?: string;
  config?: Record<string, unknown>;
}

export type AdapterName =
  | "web-chat-adapter"
  | "telegram-adapter"
  | "email-adapter"
  | "sms-adapter"
  | "vk-adapter"
  | "max-adapter"
  | "whatsapp-adapter";

export interface CapabilityDescriptorFacade {
  contract: "C6.CapabilityDescriptor";
  version: "1.0.0";
  channel_type: ChannelType;
  channel_id: string;
  adapter: {
    name: AdapterName;
    version: "0.0.0";
  };
  capabilities: Record<CapabilityName, { supported: boolean; notes?: string }>;
  generated_at: string;
}

const C6_CAPABILITIES: CapabilityName[] = [
  "text",
  "image",
  "file",
  "voice",
  "video",
  "buttons",
  "reactions",
  "typing_indicator",
  "read_receipt",
  "delete",
  "edit",
];
const WEB_CHAT_SUPPORTED_CAPABILITIES = new Set<CapabilityName>([
  "text",
  "image",
  "file",
  "typing_indicator",
  "read_receipt",
]);
const CHANNEL_CAPABILITY_PROFILES: Record<
  ChannelType,
  {
    adapterName: AdapterName;
    supported: ReadonlySet<CapabilityName>;
    notes?: Partial<Record<CapabilityName, string>>;
  }
> = {
  web_chat: {
    adapterName: "web-chat-adapter",
    supported: WEB_CHAT_SUPPORTED_CAPABILITIES,
  },
  telegram: {
    adapterName: "telegram-adapter",
    supported: new Set([
      "text",
      "image",
      "file",
      "voice",
      "video",
      "buttons",
      "typing_indicator",
      "delete",
      "edit",
    ]),
    notes: {
      read_receipt:
        "Telegram Bot API does not expose reliable per-user read receipts to the adapter.",
    },
  },
  email: {
    adapterName: "email-adapter",
    supported: new Set(["text", "image", "file"]),
    notes: {
      read_receipt:
        "Email read receipts are optional and not reliable enough for C6 read_receipt.",
    },
  },
  sms: {
    adapterName: "sms-adapter",
    supported: new Set(["text"]),
  },
  vk: {
    adapterName: "vk-adapter",
    supported: new Set([
      "text",
      "image",
      "file",
      "voice",
      "video",
      "buttons",
      "typing_indicator",
    ]),
    notes: {
      read_receipt: "The M2 VK adapter does not publish reliable read receipts to C6.",
    },
  },
  max: {
    adapterName: "max-adapter",
    supported: new Set([
      "text",
      "image",
      "file",
      "voice",
      "video",
      "buttons",
      "typing_indicator",
    ]),
    notes: {
      read_receipt: "The M2 MAX adapter does not publish read receipt events.",
    },
  },
  whatsapp: {
    adapterName: "whatsapp-adapter",
    supported: new Set([
      "text",
      "image",
      "file",
      "voice",
      "video",
      "buttons",
      "read_receipt",
    ]),
    notes: {
      typing_indicator: "The M2 WhatsApp adapter does not expose typing indicators.",
    },
  },
};

@Injectable()
export class IntegrationGatewayFacade {
  private readonly channels = new Map<string, ChannelFacade>();

  constructor(
    @Optional()
    @Inject(INTEGRATION_GATEWAY_CLOCK)
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  getStatus(): FacadeStatusDto {
    return {
      mode: "mock",
      name: "integration",
      serviceId: "SVC-INT",
      status: "degraded",
    };
  }

  listChannels(organizationId?: string): ChannelFacade[] {
    return Array.from(this.channels.values())
      .filter((channel) => !organizationId || channel.organization_id === organizationId)
      .map((channel) => ({ ...channel }));
  }

  connectWebChatChannel(request: ConnectWebChatChannelRequest): ChannelFacade {
    return this.connectChannel({
      ...request,
      channel_type: "web_chat",
    });
  }

  connectChannel(request: ConnectChannelRequest): ChannelFacade {
    const timestamp = this.clock();
    const channelType = request.channel_type;
    const channel: ChannelFacade = {
      id: `${channelType.replace("_", "-")}-${randomUUID()}`,
      organization_id: request.organization_id,
      channel_type: channelType,
      name: request.name,
      status: "connected",
      ...(request.credentials_ref ? { credentials_ref: request.credentials_ref } : {}),
      config: request.config ?? {},
      created_at: timestamp,
      updated_at: timestamp,
    };

    this.channels.set(channel.id, channel);

    return { ...channel };
  }

  getChannelCapabilities(channelId: string, organizationId?: string): CapabilityDescriptorFacade {
    const channel = this.getChannel(channelId, organizationId);

    return createChannelCapabilityDescriptor({
      channelType: channel.channel_type,
      channelId: channel.id,
      generatedAt: this.clock(),
    });
  }

  testChannel(channelId: string, organizationId?: string): {
    accepted: true;
    channel_id: string;
    status: ChannelStatus;
    checked_at: string;
  } {
    const channel = this.getChannel(channelId, organizationId);
    const checkedAt = this.clock();
    const updatedChannel = {
      ...channel,
      last_check_at: checkedAt,
      status: "connected" as const,
      updated_at: checkedAt,
    };

    this.channels.set(channel.id, updatedChannel);

    return {
      accepted: true,
      channel_id: channel.id,
      status: updatedChannel.status,
      checked_at: checkedAt,
    };
  }

  private getChannel(channelId: string, organizationId?: string): ChannelFacade {
    const channel = this.channels.get(channelId);
    if (!channel || (organizationId && channel.organization_id !== organizationId)) {
      throw new NotFoundException({
        code: "CHANNEL_NOT_FOUND",
        description: "Channel was not found.",
        humanMessage: "Канал не найден.",
      });
    }

    return channel;
  }
}

function createChannelCapabilityDescriptor({
  channelType,
  channelId,
  generatedAt,
}: {
  channelType: ChannelType;
  channelId: string;
  generatedAt: string;
}): CapabilityDescriptorFacade {
  const profile = CHANNEL_CAPABILITY_PROFILES[channelType];

  return {
    contract: "C6.CapabilityDescriptor",
    version: "1.0.0",
    channel_type: channelType,
    channel_id: channelId,
    adapter: {
      name: profile.adapterName,
      version: "0.0.0",
    },
    capabilities: Object.fromEntries(
      C6_CAPABILITIES.map((capability) => [
        capability,
        profile.supported.has(capability)
          ? { supported: true }
          : {
              supported: false,
              notes:
                profile.notes?.[capability] ??
                `Not supported by the M2 ${channelType} adapter.`,
            },
      ]),
    ) as Record<CapabilityName, { supported: boolean; notes?: string }>,
    generated_at: generatedAt,
  };
}
