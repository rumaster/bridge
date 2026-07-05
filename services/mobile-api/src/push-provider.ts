/**
 * Мок push-провайдера (FCM/APNs) для SVC-MOB (M4, ТЗ §19.4, §26.4). Внешние
 * провайдеры смоделированы инъектируемым моком: фиксирует отправки, умеет
 * возвращать «мёртвый» токен (не подлежит ретраю → деактивация) и временную
 * недоступность (подлежит ретраю). Детерминирован.
 *
 * Контракт результата send():
 *   { ok, retryable?, reason?, provider, token, provider_ref, delivered_at? }
 */
export function createMockPushProvider({
  deadTokens = [],
  transientTokens = [],
  now = () => new Date().toISOString(),
} = {}) {
  const dead = new Set(deadTokens);
  const transient = new Map();
  for (const token of transientTokens) {
    transient.set(token, (transient.get(token) ?? 0) + 1);
  }

  const dispatches = [];
  const metrics = {
    send_total: 0,
    delivered_total: 0,
    dead_token_total: 0,
    transient_failure_total: 0,
  };
  let counter = 0;

  return {
    send(pushPayload) {
      metrics.send_total += 1;
      counter += 1;
      const provider = pushPayload.provider;
      const token = pushPayload.payload?.token;
      const providerRef = `${provider}:${token}:${counter}`;

      if (dead.has(token)) {
        metrics.dead_token_total += 1;
        const record = {
          ok: false,
          retryable: false,
          reason: "token_unregistered",
          provider,
          token,
          provider_ref: providerRef,
          attempted_at: now(),
        };
        dispatches.push(record);
        return { ...record };
      }

      const remaining = transient.get(token) ?? 0;
      if (remaining > 0) {
        transient.set(token, remaining - 1);
        metrics.transient_failure_total += 1;
        const record = {
          ok: false,
          retryable: true,
          reason: "provider_unavailable",
          provider,
          token,
          provider_ref: providerRef,
          attempted_at: now(),
        };
        dispatches.push(record);
        return { ...record };
      }

      metrics.delivered_total += 1;
      const record = {
        ok: true,
        provider,
        token,
        provider_ref: providerRef,
        delivered_at: now(),
      };
      dispatches.push(record);
      return { ...record };
    },

    getDispatches() {
      return dispatches.map((dispatch) => ({ ...dispatch }));
    },

    getMetrics() {
      return { ...metrics };
    },
  };
}
