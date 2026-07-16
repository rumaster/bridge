import { useRef } from "react";

import { renderHighlightedHtml } from "./js-highlight";

export interface CodeEditorProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Имена data-входов: кнопки подставляют их в код по месту каретки. */
  inputPorts?: readonly string[];
  rows?: number;
  error?: string;
}

/**
 * Многострочный редактор JS с подсветкой.
 *
 * Приём — слой `<pre>` под прозрачной `<textarea>`: настоящее поле ввода остаётся
 * нативным (каретка, выделение, undo, IME работают сами), а подсветка рисуется
 * под ним и синхронизируется по скроллу. Это дешевле, чем тянуть CodeMirror ради
 * короткого тела функции, и не ломает доступность.
 *
 * Требование к подсветке: она обязана возвращать РОВНО тот же текст, иначе слои
 * разъедутся (см. инвариант в js-highlight.ts).
 */
export function CodeEditor({ error, id, inputPorts = [], label, onChange, rows = 10, value }: CodeEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);

  const syncScroll = (): void => {
    if (!textareaRef.current || !highlightRef.current) return;
    highlightRef.current.scrollTop = textareaRef.current.scrollTop;
    highlightRef.current.scrollLeft = textareaRef.current.scrollLeft;
  };

  /** Вставка имени порта по месту каретки: набирать его руками — лишний повод ошибиться. */
  const insertPort = (port: string): void => {
    const field = textareaRef.current;
    if (!field) return;
    const start = field.selectionStart ?? value.length;
    const end = field.selectionEnd ?? start;
    const next = `${value.slice(0, start)}input.${port}${value.slice(end)}`;
    onChange(next);
    queueMicrotask(() => {
      const caret = start + `input.${port}`.length;
      field.focus();
      field.setSelectionRange(caret, caret);
    });
  };

  return (
    <div className="wf-code-editor">
      <label className="wf-code-label" htmlFor={id}>
        {label}
      </label>

      {inputPorts.length > 0 ? (
        <div className="wf-code-ports">
          <span className="wf-hint">Входы:</span>
          {inputPorts.map((port) => (
            <button
              className="wf-code-port-chip"
              key={port}
              onClick={() => insertPort(port)}
              type="button"
            >
              {port}
            </button>
          ))}
        </div>
      ) : null}

      <div className="wf-code-area">
        <pre aria-hidden="true" className="wf-code-highlight" ref={highlightRef}>
          {/* Подсветка — только слой отрисовки; источник истины — value в textarea. */}
          <code dangerouslySetInnerHTML={{ __html: renderHighlightedHtml(value) }} />
        </pre>
        <textarea
          className="wf-code-input"
          id={id}
          onChange={(event) => onChange(event.currentTarget.value)}
          onScroll={syncScroll}
          ref={textareaRef}
          rows={rows}
          spellCheck={false}
          value={value}
        />
      </div>

      {error ? <p className="wf-error">{error}</p> : null}
    </div>
  );
}
