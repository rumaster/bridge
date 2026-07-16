import { FBP_PORT_TYPES, configPortRows, portColor } from "@bridge/contracts/c5-workflow";
import type { FbpConfigPortRow, FbpPortType } from "@bridge/contracts/c5-workflow";
import { Plus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

import { Button, SelectInput, TextInput } from "../../shared/ui-kit";

export interface PortRowsEditorProps {
  /** Заголовок группы: «Входы» / «Выходы». */
  label: string;
  value: unknown;
  onChange: (rows: FbpConfigPortRow[]) => void;
  /** Выходы transform адресуются путём от `{ result }` — только у них есть path. */
  withPath?: boolean;
  idPrefix: string;
}

/**
 * Редактор строк портов узла (`config.inputs` / `config.outputs`).
 *
 * Ключевое решение — ЛОКАЛЬНОЕ состояние строк с коммитом на blur. Без него имя
 * порта нельзя стереть и набрать заново: пустое имя отбрасывается нормализацией
 * контракта, порт исчезает на первом же нажатии Backspace, а вместе с ним —
 * фокус и всё, что оператор успел напечатать.
 */
export function PortRowsEditor({ idPrefix, label, onChange, value, withPath = false }: PortRowsEditorProps) {
  const [rows, setRows] = useState<FbpConfigPortRow[]>(() => configPortRows(value));

  // Синк при переключении узла — прямо в теле рендера, без useEffect: иначе
  // панель на один кадр показала бы порты предыдущего узла.
  const previous = useRef(value);
  if (previous.current !== value) {
    previous.current = value;
    setRows(configPortRows(value));
  }

  /** Наружу уходят только именованные строки: безымянный порт не существует. */
  const commit = (next: FbpConfigPortRow[]): void => {
    onChange(next.filter((row) => row.name.trim() !== ""));
  };

  const patchLocal = (index: number, patch: Partial<FbpConfigPortRow>): void => {
    setRows((current) => current.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  };

  const addRow = (): void => {
    const next = [...rows, { name: nextPortName(rows), type: "string" as FbpPortType }];
    setRows(next);
    commit(next);
  };

  const removeRow = (index: number): void => {
    const next = rows.filter((_, position) => position !== index);
    setRows(next);
    commit(next);
  };

  return (
    <div className="wf-ports-editor" data-testid={`${idPrefix}-ports-editor`}>
      <div className="wf-ports-editor-head">
        <span className="wf-ports-editor-label">{label}</span>
        <Button onClick={addRow} type="button" variant="ghost">
          <Plus aria-hidden="true" size={14} />
          Добавить порт
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="wf-hint">Портов нет.</p>
      ) : (
        <ul className="wf-ports-editor-rows">
          {rows.map((row, index) => (
            <li className="wf-ports-editor-row" key={index}>
              <span className="wf-port-dot" style={{ background: portColor(row.type) }} />
              <TextInput
                label={`${label}: имя порта ${index + 1}`}
                className="wf-port-field"
                id={`${idPrefix}-port-name-${index}`}
                // Имя коммитится на blur, а не на каждое нажатие: иначе порт
                // исчезал бы при попытке стереть его имя целиком.
                onBlur={() => commit(rows)}
                onChange={(event) => patchLocal(index, { name: event.currentTarget.value })}
                value={row.name}
              />
              {withPath ? (
                <TextInput
                  label={`${label}: путь порта ${index + 1}`}
                  className="wf-port-field"
                  id={`${idPrefix}-port-path-${index}`}
                  onBlur={() => commit(rows)}
                  onChange={(event) => patchLocal(index, { path: event.currentTarget.value })}
                  placeholder="result.name"
                  value={row.path ?? ""}
                />
              ) : null}
              <SelectInput
                label={`${label}: тип порта ${index + 1}`}
                className="wf-port-field"
                id={`${idPrefix}-port-type-${index}`}
                onChange={(event) => {
                  const type = event.currentTarget.value as FbpPortType;
                  const next = rows.map((item, position) =>
                    position === index ? { ...item, type } : item,
                  );
                  setRows(next);
                  // Тип — выбор из списка, а не набор текста: коммитим сразу.
                  commit(next);
                }}
                options={FBP_PORT_TYPES.filter((type) => type !== "exec").map((type) => ({
                  label: type,
                  value: type,
                }))}
                value={row.type}
              />
              <Button
                aria-label={`Удалить порт ${row.name || index + 1}`}
                onClick={() => removeRow(index)}
                type="button"
                variant="ghost"
              >
                <Trash2 aria-hidden="true" size={14} />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function nextPortName(rows: readonly FbpConfigPortRow[]): string {
  const taken = new Set(rows.map((row) => row.name));
  let index = rows.length + 1;
  while (taken.has(`port_${index}`)) index += 1;
  return `port_${index}`;
}
