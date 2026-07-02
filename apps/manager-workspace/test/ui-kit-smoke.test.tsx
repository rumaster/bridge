import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button } from "../src/shared/ui-kit";

describe("temporary ui-kit adapter", () => {
  it("renders an accessible button component", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();

    render(<Button onClick={onClick}>Открыть очередь</Button>);

    await user.click(screen.getByRole("button", { name: "Открыть очередь" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
