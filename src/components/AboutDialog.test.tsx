import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AboutDialog } from "./AboutDialog";
import { api } from "../lib/api";

vi.mock("../lib/api", () => ({
  api: {
    native: true,
    checkForUpdate: vi.fn(),
    installUpdate: vi.fn(async () => undefined),
    openSite: vi.fn(),
    openPrivacy: vi.fn(),
    openReleases: vi.fn(),
  },
}));

const runtime = {
  version: "1.1.5",
  edition: "installed" as const,
  edition_label: "Installed",
  platform: "Windows",
  architecture: "x64",
  update_mode: "installer" as const,
};

describe("About update state", () => {
  it("shows the known signed update without requiring another check", async () => {
    render(
      <AboutDialog
        runtime={runtime}
        knownUpdate={{ available: true, version: "1.1.6", installable: true }}
        onClose={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(await screen.findByText("Version 1.1.6 is available.")).toBeTruthy();
    const install = screen.getByRole("button", { name: "Install and restart" });
    install.click();
    expect(api.installUpdate).toHaveBeenCalledOnce();
  });
});
