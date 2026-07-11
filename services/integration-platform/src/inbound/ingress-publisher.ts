import { stableEdgeEndpointId } from "./ids.js";

/**
 * Издатель входящего C2.IngressMessage с выбором маршрута (Этап T5,
 * docs/plan/telegram-channel-production.md).
 *
 * Два пути:
 *  - **direct** (по умолчанию): `POST CORE_INGRESS_URL` (`/internal/ingress/messages`)
 *    напрямую в ядро — как в T3.
 *  - **edge** (RF-first, для клиентов РФ): `POST EDGE_INGRESS_URL`
 *    (`/internal/edge/ingress/messages`). Edge Cluster сначала фиксирует ПДн в
 *    RF-буфере (шифртекст, sequence_number), затем тунелирует в ядро
 *    (`/internal/edge/tunnel/messages` → `EdgeIntakeCoordinatorService → acceptIngress`).
 *    При обрыве туннеля Edge буферизует и авто-дренажит — SVC-INT получает 202 и
 *    не блокируется; недоступность самого Edge — retryable-ошибка (драйвер не
 *    двигает оффсет и переотправит).
 *
 * Тело edge-приёма — тот же конверт C2 плюс поля верхнего уровня, которые нужны
 * Edge Cluster для секвенирования/идемпотентности: `id` (UUID сообщения) и
 * `endpoint_id` (UUID-ключ партиции). Ядро (`acceptIngress`) распознаёт конверт по
 * `contract === "C2.IngressMessage"` и резолвит endpoint по `channel_id`+`sender_ref`
 * сам, поэтому синтезировать DB-идентификаторы в SVC-INT не нужно.
 */

/** Ошибка нормализации: апдейт не пригоден для приёма (сервисное сообщение и т.п.). */
export class NonIngestibleUpdateError extends Error {
  readonly nonIngestible = true;
  constructor(message: string) {
    super(message);
    this.name = "NonIngestibleUpdateError";
  }
}

/** Транспортная ошибка публикации (ядро/edge недоступны, 5xx): повторяемая. */
export class IngressPublishError extends Error {
  readonly retryable = true;
  readonly route: string;
  readonly status?: number;
  constructor(message: string, { route, status }: { route: string; status?: number }) {
    super(message);
    this.name = "IngressPublishError";
    this.route = route;
    this.status = status;
  }
}

export interface IngressPublisherOptions {
  coreIngressUrl: string;
  edgeIngressUrl?: string | null;
  fetchImpl?: typeof globalThis.fetch;
}

export interface PublishRouteOptions {
  routeViaEdge?: boolean;
}

export function createIngressPublisher({
  coreIngressUrl,
  edgeIngressUrl = null,
  fetchImpl = globalThis.fetch,
}: IngressPublisherOptions) {
  const edgeUrl = edgeIngressUrl?.trim() || null;

  return {
    /** Доступен ли edge-маршрут (задан EDGE_INGRESS_URL). */
    edgeAvailable(): boolean {
      return Boolean(edgeUrl);
    },

    /**
     * Публикует C2-конверт. `routeViaEdge` (для клиента РФ) переключает на Edge;
     * при отсутствии edgeIngressUrl всегда идёт direct в ядро.
     */
    async publish(ingress: any, { routeViaEdge = false }: PublishRouteOptions = {}): Promise<{ route: string; status: number }> {
      const viaEdge = routeViaEdge && Boolean(edgeUrl);
      return viaEdge ? postEdge(ingress) : postCore(ingress);
    },
  };

  async function postCore(ingress: any) {
    const status = await postJson(coreIngressUrl, ingress, "core");
    return { route: "core", status };
  }

  async function postEdge(ingress: any) {
    const message = ingress?.message ?? {};
    const body = {
      ...ingress,
      // Поля верхнего уровня для Edge Cluster (секвенирование/идемпотентность).
      id: message.message_id,
      idempotency_key: message.message_id,
      endpoint_id: stableEdgeEndpointId(
        String(message.channel_id ?? ""),
        String(message.sender_ref ?? message.conversation_ref ?? "anonymous"),
      ),
    };
    const status = await postJson(edgeUrl as string, body, "edge");
    return { route: "edge", status };
  }

  async function postJson(url: string, body: any, route: string): Promise<number> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new IngressPublishError(
        `Ingress ${route} publish failed: ${error instanceof Error ? error.message : String(error)}`,
        { route },
      );
    }

    if (!response.ok) {
      throw new IngressPublishError(`Ingress ${route} rejected with HTTP ${response.status}`, {
        route,
        status: response.status,
      });
    }

    return response.status;
  }
}
