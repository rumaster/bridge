import { FBP_NODE_TYPES } from "../../../../packages/contracts/src/c5.mjs";
import { backendApiNode } from "./backend-api.mjs";
import { branchNode } from "./branch.mjs";
import { knowledgeBaseSearchNode } from "./knowledge-base-search.mjs";
import { llmNode } from "./llm.mjs";
import { transformNode } from "./transform.mjs";
import { waitEventNode } from "./wait-event.mjs";

/**
 * Реестр предметно-нейтральных узлов (ТЗ §13.13-п.1). Единый источник истины —
 * каталог `FBP_NODE_TYPES` контракта C5; реестр обязан покрывать его полностью и
 * без «лишних» типов. Рассинхронизация ловится контрактным/юнит-тестом.
 */
const DEFINITIONS = [
  backendApiNode,
  llmNode,
  knowledgeBaseSearchNode,
  branchNode,
  transformNode,
  waitEventNode,
];

const REGISTRY = new Map(DEFINITIONS.map((node) => [node.type, node]));

// Ранняя проверка целостности: реестр в точности соответствует каталогу C5.
assertRegistryMatchesCatalog();

export function getNodeDefinition(type) {
  return REGISTRY.get(type) ?? null;
}

export function hasNodeType(type) {
  return REGISTRY.has(type);
}

export function listNodeTypes() {
  return [...REGISTRY.keys()];
}

function assertRegistryMatchesCatalog() {
  const catalog = new Set(FBP_NODE_TYPES);
  const registered = new Set(REGISTRY.keys());

  const missing = [...catalog].filter((type) => !registered.has(type));
  const extra = [...registered].filter((type) => !catalog.has(type));

  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Реестр узлов рассинхронизирован с каталогом C5. Отсутствуют: [${missing.join(", ")}], лишние: [${extra.join(", ")}].`,
    );
  }
}
