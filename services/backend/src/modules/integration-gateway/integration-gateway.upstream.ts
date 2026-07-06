export interface IntegrationGatewayUpstreamChannel {
  id: string;
  organization_id: string;
  channel_type: string;
}

export interface IntegrationGatewayUpstreamClient {
  getChannelCapabilities(
    channelId: string,
    organizationId?: string,
    channelType?: string,
  ): Promise<Record<string, unknown>>;
  testChannel?(
    channel: IntegrationGatewayUpstreamChannel,
  ): Promise<{ status: "connected" | "error" | "disabled"; checked_at?: string }>;
}

export const INTEGRATION_GATEWAY_UPSTREAM_CLIENT = "INTEGRATION_GATEWAY_UPSTREAM_CLIENT";

export interface IntegrationGatewayHttpUpstreamClientOptions {
  baseUrl: string;
  fetchImpl?: typeof globalThis.fetch;
}

export class IntegrationGatewayHttpUpstreamClient implements IntegrationGatewayUpstreamClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor({
    baseUrl,
    fetchImpl = globalThis.fetch,
  }: IntegrationGatewayHttpUpstreamClientOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  async getChannelCapabilities(
    channelId: string,
    _organizationId?: string,
    channelType?: string,
  ): Promise<Record<string, unknown>> {
    if (!channelType) {
      throw new Error("channelType is required for SVC-INT capability lookup");
    }

    const response = await this.fetchImpl(
      `${this.baseUrl}/${channelType.replaceAll("_", "-")}/capabilities`,
      {
        headers: {
          accept: "application/json",
        },
      },
    );
    const body = await readJson(response);
    if (!response.ok) {
      throw new Error(
        `SVC-INT capability lookup failed with HTTP ${response.status}: ${JSON.stringify(body)}`,
      );
    }

    return {
      ...body,
      channel_id: body.channel_id ?? channelId,
    };
  }

  async testChannel(
    channel: IntegrationGatewayUpstreamChannel,
  ): Promise<{ status: "connected"; checked_at: string }> {
    await this.getChannelCapabilities(
      channel.id,
      channel.organization_id,
      channel.channel_type,
    );

    return {
      checked_at: new Date().toISOString(),
      status: "connected",
    };
  }
}

export function createIntegrationGatewayHttpUpstreamClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): IntegrationGatewayUpstreamClient | null {
  const baseUrl = env.INTEGRATION_GATEWAY_URL?.trim();
  if (!baseUrl) {
    return null;
  }

  return new IntegrationGatewayHttpUpstreamClient({ baseUrl });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (text.trim() === "") {
    return {};
  }

  return JSON.parse(text) as Record<string, unknown>;
}
