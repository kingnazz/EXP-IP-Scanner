import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SecurityView } from "./SecurityView";
import { sampleSecurityRun, securitySource } from "../test/security";

async function setup() {
  const run = await sampleSecurityRun();
  const onStart = vi.fn(async () => {});
  render(
    <SecurityView
      source={securitySource}
      devices={run.devices}
      run={run}
      busy={false}
      error={null}
      onStop={vi.fn()}
      onStart={onStart}
      onError={vi.fn()}
      focusIp={null}
    />,
  );
  return { run, onStart };
}
it("requires a separate authorization action for low-impact Deep Scan", async () => {
  const { onStart } = await setup();
  fireEvent.click(screen.getByRole("button", { name: "Deep Scan" }));
  const dialog = screen.getByRole("dialog", { name: "Deep Scan" });
  expect(dialog.textContent).toContain(
    "Only scan systems you own or are authorized to test.",
  );
  const start = within(dialog).getByRole("button", {
    name: "Start low-impact verification",
  });
  expect(start.hasAttribute("disabled")).toBe(true);
  fireEvent.click(start);
  expect(onStart).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("checkbox"));
  fireEvent.click(start);
  expect(onStart).toHaveBeenCalledWith(true);
});
it("presents evidence, score factors and conservative finding status", async () => {
  await setup();
  fireEvent.click(
    screen.getByRole("button", { name: /View security details/ }),
  );
  expect(screen.getByText(/Critical −30/)).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: /PHP2Shell exposure assessment/ }),
  );
  const detail = screen.getByRole("dialog", {
    name: "PHP2Shell exposure assessment",
  });
  expect(detail.textContent).toContain("POSSIBLY VULNERABLE");
  expect(detail.textContent).toContain("CVE-2026-109618");
  expect(detail.textContent).toContain("unverified");
  expect(detail.textContent).toContain("Remediation");
});
it("renders remote titles and evidence as text", async () => {
  const run = await sampleSecurityRun();
  run.devices[0]!.services[0]!.title = '<img src=x onerror="window.bad=true">';
  const view = render(
    <SecurityView
      source={securitySource}
      devices={run.devices}
      run={run}
      busy={false}
      error={null}
      onStop={vi.fn()}
      onStart={vi.fn(async () => {})}
      onError={vi.fn()}
      focusIp={run.devices[0]!.device_ip}
    />,
  );
  expect(view.container.querySelector("img")).toBeNull();
  expect(view.container.textContent).toContain(
    '<img src=x onerror="window.bad=true">',
  );
});

it("bounds rendered device cards while keeping the full assessment searchable", async () => {
  const run = await sampleSecurityRun();
  const base = run.devices[0]!;
  const devices = Array.from({ length: 81 }, (_, index) => ({
    ...base,
    device_ip: `192.0.2.${index + 1}`,
    hostname: null,
    findings: [],
  }));
  render(
    <SecurityView
      source={securitySource}
      devices={devices}
      run={{ ...run, devices }}
      busy={false}
      error={null}
      onStop={vi.fn()}
      onStart={vi.fn(async () => {})}
      onError={vi.fn()}
      focusIp={null}
    />,
  );
  expect(
    screen.getAllByRole("button", { name: /View security details for/ }),
  ).toHaveLength(40);
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(
    screen.getAllByRole("button", { name: /View security details for/ }),
  ).toHaveLength(40);
  fireEvent.change(screen.getByLabelText("Find a device or technology"), {
    target: { value: "192.0.2.80" },
  });
  expect(
    screen.getAllByRole("button", { name: /View security details for/ }),
  ).toHaveLength(1);
});
