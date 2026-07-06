import { ChannelDeliveryError } from "./errors.js";

export interface AdapterDeliveryChannelOptions {
  adapters?: Record<string, any>;
  fallbackChannel?: any;
}

export function createAdapterDeliveryChannel({
  adapters = {},
  fallbackChannel,
}: AdapterDeliveryChannelOptions = {}) {
  const registry = new Map(
    Object.entries(adapters).filter((entry): entry is [string, any] => Boolean(entry[1])),
  );

  return {
    async deliver(request: any = {}) {
      const { channelType, delivery, idempotencyKey, message, signal } = request;
      const adapter = registry.get(channelType);
      if (adapter?.acceptEgressDelivery) {
        const result = await adapter.acceptEgressDelivery(delivery, { signal });
        if (!result.accepted) {
          throw new ChannelDeliveryError(
            result.errors?.join("; ") || `${channelType} adapter rejected delivery`,
            {
              retryable: false,
              category: "adapter_rejected",
            },
          );
        }

        return {
          delivered: true,
          duplicate: Boolean(result.duplicate),
          external_message_id:
            result.external_message_id ??
            result.delivery?.external_message_id ??
            result.delivery?.provider_response?.external_message_id ??
            null,
        };
      }

      if (fallbackChannel?.deliver) {
        return fallbackChannel.deliver({ channelType, delivery, idempotencyKey, message, signal });
      }

      throw new ChannelDeliveryError(`No external delivery adapter for ${channelType}`, {
        retryable: false,
        category: "adapter_missing",
      });
    },
  };
}
