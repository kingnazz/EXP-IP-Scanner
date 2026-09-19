import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TopBar } from "./TopBar";

function renderTopBar(updateVersion: string | null) {
  const onOpenAbout = vi.fn();
  render(
    <TopBar
      theme="system"
      onThemeChange={vi.fn()}
      onOpenSettings={vi.fn()}
      onOpenAbout={onOpenAbout}
      updateVersion={updateVersion}
      version="1.1.4"
      edition={null}
    />,
  );
  return onOpenAbout;
}

describe("top bar update indicator", () => {
  it("stays out of the way when there is no update", () => {
    renderTopBar(null);
    expect(screen.queryByRole("button", { name: /update available/i })).toBeNull();
  });

  it("shows the available version and opens About", () => {
    const onOpenAbout = renderTopBar("1.1.5");
    const button = screen.getByRole("button", { name: "Update available: version 1.1.5" });
    expect(button.textContent).toContain("Update v1.1.5");

    fireEvent.click(button);
    expect(onOpenAbout).toHaveBeenCalledTimes(1);
  });
});
