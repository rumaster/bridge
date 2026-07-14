import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

/**
 * Смещение зоны от UTC в формате ±HH:MM на текущий момент — Intl учитывает
 * переход на летнее время там, где он действует (Europe/London: +00:00 зимой,
 * +01:00 летом). Для UTC Intl отдаёт просто "GMT" без числа, поэтому
 * нормализуем к "+00:00". Неизвестная зона роняет Intl (RangeError) — тогда
 * колонка смещения пустая, но имя зоны всё равно показываем.
 */
export function getTimezoneOffsetLabel(timeZone: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset"
    }).formatToParts(at);
    const timeZoneName = parts.find((part) => part.type === "timeZoneName")?.value ?? "";
    const offset = /GMT([+-]\d{2}:\d{2})/.exec(timeZoneName);

    return offset ? offset[1] : "+00:00";
  } catch {
    return "";
  }
}

export interface TimezoneSelectProps {
  label: string;
  value: string;
  options: string[];
  onChange: (timezone: string) => void;
  error?: string;
  id?: string;
  required?: boolean;
  disabled?: boolean;
}

/**
 * Выбор часового пояса: смещение слева, имя зоны справа, две выровненные
 * колонки. Нативный <select> так не умеет — стилизация <option> в браузерах
 * недоступна, поэтому здесь паттерн ARIA combobox + listbox: фокус остаётся на
 * триггере, активная опция сообщается через aria-activedescendant.
 */
export function TimezoneSelect({
  label,
  value,
  options,
  onChange,
  error,
  id,
  required,
  disabled
}: TimezoneSelectProps) {
  const generatedId = useId();
  const inputId = id ?? `timezone-${generatedId}`;
  const listboxId = `${inputId}-listbox`;
  const errorId = error ? `${inputId}-error` : undefined;
  const optionId = (index: number) => `${inputId}-option-${index}`;

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const activeOptionRef = useRef<HTMLLIElement>(null);

  const zones = useMemo(
    () => options.map((zone) => ({ zone, offset: getTimezoneOffsetLabel(zone) })),
    [options]
  );
  const selectedOffset = useMemo(() => getTimezoneOffsetLabel(value), [value]);

  // Закрытие по клику вне контрола.
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function handlePointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  // Активная опция всегда в зоне видимости при навигации с клавиатуры.
  // Прокрутка необязательна: там, где scrollIntoView недоступен, контрол
  // продолжает работать, поэтому вызов защищён.
  useEffect(() => {
    if (open) {
      activeOptionRef.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [activeIndex, open]);

  function openList() {
    setActiveIndex(Math.max(0, options.indexOf(value)));
    setOpen(true);
  }

  function select(zone: string) {
    onChange(zone);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        openList();
      }
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((current) => Math.min(current + 1, options.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((current) => Math.max(current - 1, 0));
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (options[activeIndex]) {
          select(options[activeIndex]);
        }
        break;
      case "Escape":
        event.preventDefault();
        setOpen(false);
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  }

  return (
    <div className="text-input timezone-select" ref={containerRef}>
      <label htmlFor={inputId}>{label}</label>
      <div className="timezone-select-control">
        <button
          aria-activedescendant={open ? optionId(activeIndex) : undefined}
          aria-controls={listboxId}
          aria-describedby={errorId}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-invalid={Boolean(error)}
          aria-required={required}
          className="timezone-select-trigger"
          disabled={disabled}
          id={inputId}
          onClick={() => (open ? setOpen(false) : openList())}
          onKeyDown={handleKeyDown}
          ref={triggerRef}
          role="combobox"
          type="button"
        >
          <span className="timezone-offset">{selectedOffset}</span>
          <span className="timezone-zone">{value}</span>
          <ChevronDown aria-hidden="true" size={16} />
        </button>

        {open ? (
          <ul aria-labelledby={inputId} className="timezone-listbox" id={listboxId} role="listbox">
            {zones.map(({ zone, offset }, index) => (
              <li
                aria-selected={zone === value}
                className={`timezone-option ${index === activeIndex ? "active" : ""}`}
                id={optionId(index)}
                key={zone}
                onClick={() => select(zone)}
                onMouseEnter={() => setActiveIndex(index)}
                ref={index === activeIndex ? activeOptionRef : undefined}
                role="option"
              >
                <span className="timezone-offset">{offset}</span>
                <span className="timezone-zone">{zone}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {error ? (
        <span className="field-error" id={errorId}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
