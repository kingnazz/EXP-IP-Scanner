import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ETHERNET, SILENT_PRINTER, WINDOWS_SERVER, row } from "../test/devices";
import { DeviceDrawer } from "./DeviceDrawer";

function renderDrawer(
  device = WINDOWS_SERVER,
  overrides: Partial<Parameters<typeof DeviceDrawer>[0]> = {},
) {
  const spies = { onClose: vi.fn(), onAction: vi.fn() };
  const props: Parameters<typeof DeviceDrawer>[0] = {
    row: { host: device, pending: false },
    network: ETHERNET,
    pingResult: null,
    pinging: false,
    ...spies,
    ...overrides,
  };
  return { ...render(<DeviceDrawer {...props} />), spies };
}

describe("the details panel", () => {
  it("shows every field the scan gathered", () => {
    renderDrawer();
    const panel = screen.getByRole("complementary", { name: /192\.168\.50\.10/ });
    const text = panel.textContent ?? "";
    expect(text).toContain("dc01.exp.local");
    expect(text).toContain("192.168.50.10");
    expect(text).toContain("00:15:5D:3A:91:22");
    expect(text).toContain("Microsoft");
    expect(text).toContain("0.62 ms");
    expect(text).toContain("128");
  });

  it("labels the device-type guess as a guess", () => {
    renderDrawer();
    expect(screen.getByText("Windows")).toBeTruthy();
    // Never presented as an identification, because a single TTL is not one.
    expect(screen.getByText("(estimated)")).toBeTruthy();
  });

  it("lists every open port with its service, not just the six the table fits", () => {
    renderDrawer();
    const services: [string, string][] = [
      ["53", "DNS"],
      ["135", "MS RPC"],
      ["139", "NetBIOS"],
      ["389", "LDAP"],
      ["445", "SMB"],
      ["3389", "RDP"],
      ["5985", "WinRM"],
    ];
    for (const [port, service] of services) {
      expect(screen.getByText(port)).toBeTruthy();
      expect(screen.getByText(service)).toBeTruthy();
    }
  });

  it("offers the one action somebody opens this kind of device to do", () => {
    const { spies } = renderDrawer();
    const primary = screen.getByRole("button", { name: "Open Remote Desktop" });
    primary.click();
    expect(spies.onAction).toHaveBeenCalledOnce();
    expect(spies.onAction.mock.calls[0]?.[0].id).toBe("rdp");
  });

  it("names the adapter the scan ran from", () => {
    renderDrawer();
    // Matched against the section's text rather than a single node, because
    // the sentence is built from several spans.
    const network = screen.getByRole("complementary").textContent ?? "";
    expect(network).toContain("Ethernet");
    expect(network).toContain("192.168.50.37");
    expect(network).toContain("192.168.50.0/24");
  });

  it("closes when asked", () => {
    const { spies } = renderDrawer();
    screen.getByRole("button", { name: "Close details" }).click();
    expect(spies.onClose).toHaveBeenCalledOnce();
  });
});

describe("a device that answered nothing", () => {
  it("explains why, rather than showing an empty panel", () => {
    renderDrawer(SILENT_PRINTER);
    expect(screen.getByText(/No open ports among the ports scanned/)).toBeTruthy();
    expect(screen.getByText(/normal for printers/)).toBeTruthy();
  });

  it("offers no Connect action, and says why in the tooltip", () => {
    renderDrawer(SILENT_PRINTER);
    // No primary action at all: there is nowhere to go.
    expect(screen.queryByRole("button", { name: "Open Remote Desktop" })).toBeNull();
    const rdp = screen.getByTitle("Port 3389 is not open");
    expect(rdp.hasAttribute("disabled")).toBe(true);
  });

  it("still offers the diagnostics, which need only an address", () => {
    renderDrawer(SILENT_PRINTER);
    expect(screen.getByTitle(/Send four pings/).hasAttribute("disabled")).toBe(false);
    expect(screen.getByTitle(/continuous ping/).hasAttribute("disabled")).toBe(false);
    expect(screen.getByTitle(/traceroute/).hasAttribute("disabled")).toBe(false);
  });
});

describe("the in-app ping", () => {
  it("shows the reply without leaving the results", () => {
    renderDrawer(WINDOWS_SERVER, {
      pingResult: {
        ip: WINDOWS_SERVER.ip,
        replied: true,
        rtt_ms: 0.62,
        ttl: 128,
        summary: "Reply from 192.168.50.10 in 0.62 ms, TTL 128",
      },
    });
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Reply from 192.168.50.10 in 0.62 ms");
  });

  it("says plainly when there was no reply", () => {
    renderDrawer(SILENT_PRINTER, {
      pingResult: {
        ip: SILENT_PRINTER.ip,
        replied: false,
        rtt_ms: null,
        ttl: null,
        summary:
          "No reply from 192.168.50.26 within 1500 ms. The device may be off, or may be configured not to answer ping.",
      },
    });
    expect(screen.getByRole("status").textContent).toContain("No reply");
    expect(screen.getByRole("status").textContent).toContain("not to answer ping");
  });
});

describe("a device still being resolved", () => {
  it("renders without inventing values it does not have yet", () => {
    renderDrawer(row({ ip: "10.0.0.9", open_ports: [80], latency_ms: 3 }, true).host, {
      row: row({ ip: "10.0.0.9", open_ports: [80], latency_ms: 3 }, true),
    });
    const panel = screen.getByRole("complementary", { name: /10\.0\.0\.9/ });
    // Absences are shown as an em dash, never as a fabricated value.
    expect(within(panel).getAllByText("—").length).toBeGreaterThan(0);
  });
});
