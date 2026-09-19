import { render, screen } from "@testing-library/react";
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
      version="1.1.5"
      edition={null}
      updateVersion={updateVersion}
    />,
  );
  return { onOpenAbout };
}

describe("the top bar update notice", () => {
  it("stays out of the way when the app is current", () => {
    renderTopBar(null);
    expect(screen.queryByRole("button", { name: /update available/i })).toBeNull();
  });

  it("shows the available version and opens About when clicked", () => {
    const { onOpenAbout } = renderTopBar("1.1.6");
    const notice = screen.getByRole("button", { name: "Update available: version 1.1.6" });
    expect(notice.textContent).toContain("Update available");
    expect(notice.textContent).toContain("v1.1.6");
    notice.click();
    expect(onOpenAbout).toHaveBeenCalledOnce();
  });
});
