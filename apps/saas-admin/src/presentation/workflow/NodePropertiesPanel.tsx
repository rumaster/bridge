import {
  FBP_BRANCH_OPERATORS,
  branchOperatorNeedsRight,
  configPortRows,
} from "@bridge/contracts/c5-workflow";
import type { FbpConfigPortRow, WorkflowNode, WorkflowSchema } from "@bridge/contracts/c5-workflow";
import { WORKFLOW_EVENT_DEFINITIONS } from "@bridge/contracts/workflow-events";

import type { BackendApiAllowlistEntry, WorkflowSubschema } from "../../api/client/types";
import { SelectInput, TextInput } from "../../shared/ui-kit";
import { workflowNodeTypeDescription, workflowNodeTypeLabel } from "../../shared/workflow";
import { CodeEditor } from "./CodeEditor";
import { PortRowsEditor } from "./PortRowsEditor";
import { dataInputPortIds } from "./graph-ops";

export interface NodePropertiesPanelProps {
  node: WorkflowNode;
  graph: WorkflowSchema;
  onPatch: (patch: Partial<WorkflowNode>) => void;
  /** Курируемая витрина: узел backend-api выбирает только из разрешённого. */
  allowlist: readonly BackendApiAllowlistEntry[];
  subschemas: readonly WorkflowSubschema[];
  readOnly?: boolean;
}

/**
 * Панель свойств узла. Все перечислимые значения приходят СПИСКОМ, а не строкой:
 * событие — из реестра, операция — из курируемой витрины, оператор ветвления — из
 * контракта, субсхема — из списка активных. Свободный ввод там, где раньше можно
 * было напечатать что угодно, порождал схемы, падающие только в рантайме.
 */
export function NodePropertiesPanel({
  allowlist,
  graph,
  node,
  onPatch,
  readOnly = false,
  subschemas,
}: NodePropertiesPanelProps) {
  const config = node.config ?? {};
  const setConfigKey = (key: string, value: unknown): void => {
    onPatch({ config: { ...config, [key]: value } });
  };
  const setPortRows = (key: string, rows: FbpConfigPortRow[]): void => {
    onPatch({ config: { ...config, [key]: rows } });
  };

  return (
    <div className="wf-properties" data-testid="workflow-node-properties">
      <header className="wf-properties-head">
        <h3>{workflowNodeTypeLabel(node.type as never)}</h3>
        <p className="wf-hint">{workflowNodeTypeDescription(node.type as never)}</p>
      </header>

      <TextInput
        disabled={readOnly}
        id="wf-node-label"
        label="Название узла"
        onChange={(event) => onPatch({ label: event.currentTarget.value })}
        value={node.label ?? ""}
      />

      <NodeSpecificConfig
        allowlist={allowlist}
        config={config}
        graph={graph}
        node={node}
        readOnly={readOnly}
        setConfigKey={setConfigKey}
        setPortRows={setPortRows}
        subschemas={subschemas}
      />
    </div>
  );
}

interface SpecificProps {
  node: WorkflowNode;
  graph: WorkflowSchema;
  config: Record<string, unknown>;
  setConfigKey: (key: string, value: unknown) => void;
  setPortRows: (key: string, rows: FbpConfigPortRow[]) => void;
  allowlist: readonly BackendApiAllowlistEntry[];
  subschemas: readonly WorkflowSubschema[];
  readOnly: boolean;
}

function NodeSpecificConfig(props: SpecificProps) {
  switch (props.node.type) {
    case "wait-event":
      return <WaitEventConfig {...props} />;
    case "backend-api":
      return <BackendApiConfig {...props} />;
    case "branch":
      return <BranchConfig {...props} />;
    case "transform":
      return <TransformConfig {...props} />;
    case "llm":
      return <LlmConfig {...props} />;
    case "knowledge-base-search":
      return <KnowledgeSearchConfig {...props} />;
    case "variable_read":
    case "variable_write":
      return <VariableConfig {...props} />;
    case "sub_schema":
      return <SubSchemaConfig {...props} />;
    case "start":
    case "end":
      return <BoundaryConfig {...props} />;
    default:
      return null;
  }
}

function WaitEventConfig({ config, readOnly, setConfigKey }: SpecificProps) {
  return (
    <>
      <SelectInput
        disabled={readOnly}
        id="wf-event-type"
        label="Событие"
        onChange={(event) => setConfigKey("event_type", event.currentTarget.value)}
        // Реестр событий, а не свободная строка: подписаться на несуществующее
        // событие значит собрать схему, которая никогда не запустится.
        options={[
          { label: "— выберите событие —", value: "" },
          ...WORKFLOW_EVENT_DEFINITIONS.map((definition) => ({
            label: `${definition.label} (${definition.event_type})`,
            value: definition.event_type,
          })),
        ]}
        value={typeof config.event_type === "string" ? config.event_type : ""}
      />
      <TextInput
        disabled={readOnly}
        id="wf-event-correlation"
        label="Сужение подписки (correlation)"
        onChange={(event) => setConfigKey("correlation", event.currentTarget.value)}
        placeholder="channel_id"
        value={typeof config.correlation === "string" ? config.correlation : ""}
      />
    </>
  );
}

function BackendApiConfig({ allowlist, config, readOnly, setConfigKey }: SpecificProps) {
  const enabled = allowlist.filter((entry) => entry.enabled);
  const current = typeof config.operation_id === "string" ? config.operation_id : "";
  // Операция могла быть разрешена, а потом закрыта: показываем её, чтобы поле не
  // обнулилось молча, и подписываем как недоступную.
  const missing = current !== "" && !enabled.some((entry) => entry.operation_id === current);

  return (
    <>
      <SelectInput
        disabled={readOnly}
        id="wf-operation-id"
        label="Вызов Backend API"
        onChange={(event) => setConfigKey("operation_id", event.currentTarget.value)}
        options={[
          { label: "— выберите вызов —", value: "" },
          ...(missing ? [{ label: `${current} — больше не разрешён`, value: current }] : []),
          ...enabled.map((entry) => ({
            label: `${entry.method} ${entry.path}${entry.mutates ? " · изменяет данные" : ""}`,
            value: entry.operation_id,
          })),
        ]}
        value={current}
      />
      {enabled.length === 0 ? (
        <p className="wf-hint">
          Витрина вызовов пуста: оператор платформы ещё не разрешил ни одной операции.
        </p>
      ) : null}
      <TextInput
        disabled={readOnly}
        id="wf-timeout"
        label="Таймаут, мс"
        onChange={(event) => setConfigKey("timeout_ms", toPositiveInt(event.currentTarget.value))}
        value={config.timeout_ms === undefined ? "" : String(config.timeout_ms)}
      />
    </>
  );
}

function BranchConfig({ config, readOnly, setConfigKey }: SpecificProps) {
  const operator = typeof config.operator === "string" ? config.operator : "";
  const needsRight = operator !== "" && branchOperatorNeedsRight(operator as never);

  return (
    <>
      <SelectInput
        disabled={readOnly}
        id="wf-operator"
        label="Оператор"
        onChange={(event) => setConfigKey("operator", event.currentTarget.value)}
        options={[
          { label: "— выберите оператор —", value: "" },
          ...FBP_BRANCH_OPERATORS.map((item) => ({ label: item.label, value: item.value })),
        ]}
        value={operator}
      />
      {needsRight ? (
        <TextInput
          disabled={readOnly}
          id="wf-right"
          label="Значение для сравнения (если порт right не подключён)"
          onChange={(event) => setConfigKey("right", event.currentTarget.value)}
          value={config.right === undefined ? "" : String(config.right)}
        />
      ) : (
        <p className="wf-hint">Оператору не нужно второе значение.</p>
      )}
    </>
  );
}

function TransformConfig({ config, graph, node, readOnly, setConfigKey, setPortRows }: SpecificProps) {
  return (
    <>
      <PortRowsEditor
        idPrefix="wf-transform-in"
        label="Входы"
        onChange={(rows) => setPortRows("inputs", rows)}
        value={config.inputs}
      />
      <CodeEditor
        id="wf-transform-code"
        inputPorts={dataInputPortIds(graph, node)}
        label="JS-код: доступны input и variables, значение возвращается через return"
        onChange={(value) => setConfigKey("code", value)}
        value={typeof config.code === "string" ? config.code : ""}
      />
      <PortRowsEditor
        idPrefix="wf-transform-out"
        label="Выходы"
        onChange={(rows) => setPortRows("outputs", rows)}
        // Выход читается путём от { result }: порт с path "result.name" получает
        // result.name.
        withPath
        value={config.outputs}
      />
      {readOnly ? null : (
        <p className="wf-hint">
          Выход берётся путём от <code>result</code>: порт с путём <code>result.name</code> получит{" "}
          <code>result.name</code>. Без пути — весь результат.
        </p>
      )}
    </>
  );
}

function LlmConfig({ config, graph, node, setConfigKey, setPortRows }: SpecificProps) {
  return (
    <>
      <PortRowsEditor
        idPrefix="wf-llm-in"
        label="Входы"
        onChange={(rows) => setPortRows("inputs", rows)}
        value={config.inputs}
      />
      <CodeEditor
        id="wf-llm-prompt"
        inputPorts={dataInputPortIds(graph, node)}
        label="Промпт: {порт} подставляет значение входа"
        onChange={(value) => setConfigKey("prompt", value)}
        rows={6}
        value={typeof config.prompt === "string" ? config.prompt : ""}
      />
      <PortRowsEditor
        idPrefix="wf-llm-out"
        label="Выходы"
        onChange={(rows) => setPortRows("outputs", rows)}
        value={config.outputs}
      />
      <p className="wf-hint">
        Порт <code>text</code> — ответ модели, <code>degraded</code> — признак заглушки,{" "}
        <code>raw</code> — ответ целиком.
      </p>
    </>
  );
}

function KnowledgeSearchConfig({ config, readOnly, setConfigKey }: SpecificProps) {
  return (
    <>
      <TextInput
        disabled={readOnly}
        id="wf-top-k"
        label="Сколько документов вернуть"
        onChange={(event) => setConfigKey("top_k", toPositiveInt(event.currentTarget.value))}
        value={config.top_k === undefined ? "" : String(config.top_k)}
      />
      <p className="wf-hint">
        Входы <code>keys</code> (ключевые фразы) и <code>tags</code> (предфильтр) подключаются
        связями; выход <code>documents</code> отдаёт найденное.
      </p>
    </>
  );
}

function VariableConfig({ config, node, readOnly, setConfigKey, setPortRows }: SpecificProps) {
  return (
    <>
      <TextInput
        disabled={readOnly}
        id="wf-variable-name"
        label="Имя переменной"
        onChange={(event) => setConfigKey("name", event.currentTarget.value)}
        value={typeof config.name === "string" ? config.name : ""}
      />
      <PortRowsEditor
        idPrefix="wf-variable"
        label={node.type === "variable_write" ? "Входы" : "Выходы"}
        onChange={(rows) => setPortRows(node.type === "variable_write" ? "inputs" : "outputs", rows)}
        value={node.type === "variable_write" ? config.inputs : config.outputs}
      />
    </>
  );
}

function SubSchemaConfig({ config, readOnly, setConfigKey, subschemas }: SpecificProps) {
  const active = subschemas.filter((subschema) => subschema.status === "active");
  const current = typeof config.subSchemaSlug === "string" ? config.subSchemaSlug : "";

  return (
    <>
      <SelectInput
        disabled={readOnly}
        id="wf-subschema-slug"
        label="Субсхема"
        onChange={(event) => setConfigKey("subSchemaSlug", event.currentTarget.value)}
        options={[
          { label: "— выберите субсхему —", value: "" },
          ...active.map((subschema) => ({
            label: `${subschema.name} (${subschema.slug})`,
            value: subschema.slug,
          })),
        ]}
        value={current}
      />
      <p className="wf-hint">
        Узел хранит только ссылку на субсхему. Её граф подставляется при исполнении, поэтому
        порты узла зеркалят границы <code>start</code>/<code>end</code> выбранной субсхемы.
      </p>
    </>
  );
}

function BoundaryConfig({ config, node, setPortRows }: SpecificProps) {
  const key = node.type === "start" ? "outputs" : "inputs";

  return (
    <>
      <BoundaryPortRows
        label={node.type === "start" ? "Что субсхема получает" : "Что субсхема отдаёт"}
        onChange={(rows) => setPortRows(key, rows)}
        value={config[key]}
      />
      <p className="wf-hint">
        Это граница субсхемы: по ней узел <code>sub_schema</code> строит свои порты в вызывающей
        схеме.
      </p>
    </>
  );
}

/**
 * Граничные порты объявляются полем `id`, а не `name`, — так задан контракт.
 * Переиспользовать `PortRowsEditor` нельзя: он редактирует `name`, и порт молча
 * не сохранился бы.
 */
function BoundaryPortRows({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (rows: FbpConfigPortRow[]) => void;
  value: unknown;
}) {
  const rows = configPortRows(
    Array.isArray(value)
      ? value.map((item) =>
          typeof item === "object" && item !== null
            ? { ...(item as Record<string, unknown>), name: (item as { id?: string }).id }
            : item,
        )
      : value,
  );

  return (
    <PortRowsEditor
      idPrefix="wf-boundary"
      label={label}
      onChange={(next) => onChange(next.map((row) => ({ id: row.name, type: row.type }) as never))}
      value={rows}
    />
  );
}

function toPositiveInt(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
