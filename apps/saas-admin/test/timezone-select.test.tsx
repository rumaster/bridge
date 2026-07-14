import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { TimezoneSelect, getTimezoneOffsetLabel } from "../src/shared/timezone-select";

const ZONES = ["UTC", "Europe/Kaliningrad", "Europe/Moscow", "Asia/Tokyo"];

function renderSelect(onChange = vi.fn(), value = "Europe/Moscow") {
  const user = userEvent.setup();
  render(
    <TimezoneSelect label="Часовой пояс" onChange={onChange} options={ZONES} value={value} />
  );

  return { onChange, user };
}

/** Контролируемая обёртка — проверяет, что выбор доходит до значения контрола. */
function ControlledSelect() {
  const [timezone, setTimezone] = useState("Europe/Moscow");

  return (
    <TimezoneSelect label="Часовой пояс" onChange={setTimezone} options={ZONES} value={timezone} />
  );
}

describe("TimezoneSelect", () => {
  describe("getTimezoneOffsetLabel", () => {
    it("форматирует смещение как ±HH:MM и нормализует UTC", () => {
      // Зоны без перехода на летнее время — смещение стабильно круглый год.
      expect(getTimezoneOffsetLabel("Europe/Moscow")).toBe("+03:00");
      expect(getTimezoneOffsetLabel("Asia/Tokyo")).toBe("+09:00");
      // Intl отдаёт для UTC просто "GMT" — нормализуем к числовому виду.
      expect(getTimezoneOffsetLabel("UTC")).toBe("+00:00");
    });

    it("учитывает переход на летнее время на конкретную дату", () => {
      const winter = new Date("2026-01-15T12:00:00Z");
      const summer = new Date("2026-07-15T12:00:00Z");

      expect(getTimezoneOffsetLabel("Europe/London", winter)).toBe("+00:00");
      expect(getTimezoneOffsetLabel("Europe/London", summer)).toBe("+01:00");
      expect(getTimezoneOffsetLabel("America/New_York", summer)).toBe("-04:00");
    });

    it("не роняет рендер на неизвестной зоне", () => {
      expect(getTimezoneOffsetLabel("Nowhere/Unknown")).toBe("");
    });
  });

  it("показывает смещение слева от имени зоны в свёрнутом виде", async () => {
    renderSelect();

    const trigger = screen.getByRole("combobox", { name: "Часовой пояс" });
    expect(trigger).toHaveTextContent("+03:00");
    expect(trigger).toHaveTextContent("Europe/Moscow");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("раскрывает список, где каждая опция — смещение и имя зоны", async () => {
    const { user } = renderSelect();

    await user.click(screen.getByRole("combobox", { name: "Часовой пояс" }));

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(ZONES.length);
    expect(options.map((option) => option.textContent)).toEqual([
      "+00:00UTC",
      "+02:00Europe/Kaliningrad",
      "+03:00Europe/Moscow",
      "+09:00Asia/Tokyo"
    ]);
    // Текущее значение помечено для скринридера.
    expect(within(screen.getByRole("listbox")).getByRole("option", { selected: true })).toHaveTextContent(
      "Europe/Moscow"
    );
  });

  it("выбирает зону мышью и закрывает список", async () => {
    const { onChange, user } = renderSelect();

    await user.click(screen.getByRole("combobox", { name: "Часовой пояс" }));
    await user.click(screen.getByRole("option", { name: /Asia\/Tokyo/ }));

    expect(onChange).toHaveBeenCalledWith("Asia/Tokyo");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("открывается с клавиатуры и выбирает зону стрелками и Enter", async () => {
    const user = userEvent.setup();
    render(<ControlledSelect />);

    const trigger = screen.getByRole("combobox", { name: "Часовой пояс" });
    trigger.focus();

    // Стрелка вниз раскрывает список, активной становится текущая зона.
    await user.keyboard("{ArrowDown}");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: /Europe\/Moscow/ }).id
    );

    // Europe/Moscow → Asia/Tokyo — следующая зона в списке.
    await user.keyboard("{ArrowDown}{Enter}");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger).toHaveTextContent("+09:00");
    expect(trigger).toHaveTextContent("Asia/Tokyo");
    // Фокус возвращается на триггер — клавиатурная навигация не теряется.
    expect(trigger).toHaveFocus();
  });

  it("закрывает список по Escape без выбора", async () => {
    const { onChange, user } = renderSelect();

    const trigger = screen.getByRole("combobox", { name: "Часовой пояс" });
    await user.click(trigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("связывает ошибку валидации с контролом", () => {
    render(
      <TimezoneSelect
        error="Часовой пояс обязателен."
        label="Часовой пояс"
        onChange={vi.fn()}
        options={ZONES}
        value="Europe/Moscow"
      />
    );

    const trigger = screen.getByRole("combobox", { name: "Часовой пояс" });
    expect(trigger).toHaveAttribute("aria-invalid", "true");
    expect(trigger).toHaveAccessibleDescription("Часовой пояс обязателен.");
  });
});
