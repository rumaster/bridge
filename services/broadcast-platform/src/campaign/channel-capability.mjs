/**
 * Учёт Capability каналов (C6) при формировании кампании (ТЗ §14.6, §10.6).
 *
 * SVC-INT публикует дескрипторы C6 (`C6.CapabilityDescriptor`) — какие типы
 * сообщений поддерживает канал и с какими ограничениями. SVC-BCAST использует их,
 * чтобы:
 *   1. **не формировать** несовместимые с каналом сообщения (плана §7): если
 *      канал не поддерживает тип шаблона — получатель пропускается;
 *   2. **учесть лимиты канала** в rate limiting (стратегия `channel_capability`):
 *      предельная скорость берётся из `constraints.messages_per_minute`
 *      дескриптора, а не из общей политики кампании.
 *
 * Дескрипторы инъектируются картой `channel -> C6.CapabilityDescriptor`.
 * Отсутствие дескриптора трактуется как «канал доступен без известных
 * ограничений» — совместимость по умолчанию, лимит берётся из политики кампании.
 */

/**
 * @param {object|undefined} descriptor Дескриптор C6 для канала (или undefined).
 * @param {string} type Тип сообщения шаблона (`text` в C8 v1).
 * @returns {boolean} Поддерживает ли канал данный тип сообщения.
 */
export function channelSupportsType(descriptor, type) {
  if (!descriptor || typeof descriptor !== "object") {
    // Нет дескриптора — считаем канал совместимым (совместимость по умолчанию).
    return true;
  }

  const capability = descriptor.capabilities?.[type];
  if (!capability || typeof capability !== "object") {
    return false;
  }

  return capability.supported === true;
}

/**
 * Предельная скорость (сообщений/мин) для канала с учётом Capability и политики
 * кампании.
 *
 * @param {object|undefined} descriptor Дескриптор C6 для канала.
 * @param {string} type Тип сообщения шаблона.
 * @param {{ messages_per_minute: number, strategy?: string }} rateLimit Политика C8.
 * @returns {number} Итоговый лимит сообщений в минуту (положительное число).
 */
export function resolveChannelRateLimit(descriptor, type, rateLimit) {
  const policyLimit = Number.isInteger(rateLimit?.messages_per_minute)
    ? rateLimit.messages_per_minute
    : Number.POSITIVE_INFINITY;

  if (rateLimit?.strategy !== "channel_capability") {
    return policyLimit;
  }

  const constraints = descriptor?.capabilities?.[type]?.constraints;
  const capabilityLimit = Number.isFinite(constraints?.messages_per_minute)
    ? constraints.messages_per_minute
    : Number.POSITIVE_INFINITY;

  // Берём минимум: нельзя превышать ни лимит канала (C6), ни политику кампании.
  return Math.min(policyLimit, capabilityLimit);
}
