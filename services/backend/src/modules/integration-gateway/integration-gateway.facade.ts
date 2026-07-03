import { randomUUID } from "node:crypto";

import { Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";

import type { FacadeStatusDto } from "../ai-integration/ai-integration.facade";

export const INTEGRATION_GATEWAY_CLOCK = Symbol("INTEGRATION_GATEWAY_CLOCK");

export type ChannelStatus = "connected" | "error" | "disabled";
export type ChannelType = "web_chat";
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
  name: string;
  credentials_ref?: string;
  config?: Record<string, unknown>;
}

export interface CapabilityDescriptorFacade {
  contract: "C6.CapabilityDescriptor";
  version: "1.0.0";
  channel_type: ChannelType;
  channel_id: string;
  adapter: {
    name: "web-chat-adapter";
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

  listChannels(): ChannelFacade[] {
    return Array.from(this.channels.values()).map((channel) => ({ ...channel }));
  }

  connectWebChatChannel(request: ConnectWebChatChannelRequest): ChannelFacade {
    const timestamp = this.clock();
    const channel: ChannelFacade = {
      id: `web-chat-${randomUUID()}`,
      organization_id: request.organization_id,
      channel_type: "web_chat",
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

  getChannelCapabilities(channelId: string): CapabilityDescriptorFacade {
    const channel = this.getChannel(channelId);

    return createWebChatCapabilityDescriptor({
      channelId: channel.id,
      generatedAt: this.clock(),
    });
  }

  testChannel(channelId: string): {
    accepted: true;
    channel_id: string;
    status: ChannelStatus;
    checked_at: string;
  } {
    const channel = this.getChannel(channelId);
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

  private getChannel(channelId: string): ChannelFacade {
    const channel = this.channels.get(channelId);
    if (!channel) {
      throw new NotFoundException({
        code: "CHANNEL_NOT_FOUND",
        description: "Channel was not found.",
        humanMessage: "Канал не найден.",
      });
    }

    return channel;
  }
}

function createWebChatCapabilityDescriptor({
  channelId,
  generatedAt,
}: {
  channelId: string;
  generatedAt: string;
}): CapabilityDescriptorFacade {
  return {
    contract: "C6.CapabilityDescriptor",
    version: "1.0.0",
    channel_type: "web_chat",
    channel_id: channelId,
    adapter: {
      name: "web-chat-adapter",
      version: "0.0.0",
    },
    capabilities: Object.fromEntries(
      C6_CAPABILITIES.map((capability) => [
        capability,
        WEB_CHAT_SUPPORTED_CAPABILITIES.has(capability)
          ? { supported: true }
          : {
              supported: false,
              notes: "Not supported by the M1 Web Chat adapter.",
            },
      ]),
    ) as Record<CapabilityName, { supported: boolean; notes?: string }>,
    generated_at: generatedAt,
  };
}
