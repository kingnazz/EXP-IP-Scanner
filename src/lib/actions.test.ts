import { describe, expect, it } from "vitest";
import {
  ACCESS_POINT,
  FIREWALL,
  IP_CAMERA,
  NAS,
  PRINTER,
  SILENT_PRINTER,
  WINDOWS_SERVER,
  WORKSTATION,
  host,
} from "../test/devices";
import { actionsInGroup, deviceActions, primaryAction, type ActionId } from "./actions";
import type { HostResult } from "../types";

const available = (h: HostResult): ActionId[] =>
  deviceActions(h)
    .filter((a) => a.available)
    .map((a) => a.id);

const action = (h: HostResult, id: ActionId) => {
  const found = deviceActions(h).find((a) => a.id === id);
  if (!found) throw new Error(`no action ${id}`);
  return found;
};

describe("action enablement follows the open ports", () => {
  it("offers Remote Desktop only when 3389 is open", () => {
    expect(action(WINDOWS_SERVER, "rdp").available).toBe(true);
    expect(action(WORKSTATION, "rdp").available).toBe(true);
    expect(action(PRINTER, "rdp").available).toBe(false);
    expect(action(ACCESS_POINT, "rdp").available).toBe(false);
  });

  it("offers file shares for SMB and for legacy NetBIOS", () => {
    expect(action(WINDOWS_SERVER, "smb").port).toBe(445);
    expect(action(NAS, "smb").port).toBe(445);
    expect(action(host({ ip: "10.0.0.1", open_ports: [139] }), "smb").port).toBe(139);
    expect(action(IP_CAMERA, "smb").available).toBe(false);
  });

  it("offers SSH only when 22 is open", () => {
    expect(action(ACCESS_POINT, "ssh").available).toBe(true);
    expect(action(FIREWALL, "ssh").available).toBe(true);
    expect(action(WORKSTATION, "ssh").available).toBe(false);
  });

  it("offers a web interface on whichever port the device serves, preferring HTTPS", () => {
    expect(action(ACCESS_POINT, "web").port).toBe(443);
    expect(action(PRINTER, "web").port).toBe(443);
    expect(action(IP_CAMERA, "web").port).toBe(80);
    expect(action(host({ ip: "10.0.0.1", open_ports: [8443] }), "web").port).toBe(8443);
    expect(action(WORKSTATION, "web").available).toBe(false);
  });

  it("offers VNC only when a display port is open", () => {
    expect(action(host({ ip: "10.0.0.1", open_ports: [5900] }), "vnc").port).toBe(5900);
    expect(action(host({ ip: "10.0.0.1", open_ports: [5901] }), "vnc").port).toBe(5901);
    expect(action(WINDOWS_SERVER, "vnc").available).toBe(false);
  });

  it("offers nothing under Connect for a device that answered nothing", () => {
    // The ARP-only printer. Every Connect action has to be disabled, or a
    // consultant clicks and waits for a timeout.
    const connect = actionsInGroup(SILENT_PRINTER, "connect");
    expect(connect).not.toHaveLength(0);
    expect(connect.every((a) => !a.available)).toBe(true);
  });
});

describe("the actions that need only an address", () => {
  it("are always available, for every device", () => {
    for (const device of [WINDOWS_SERVER, SILENT_PRINTER, IP_CAMERA]) {
      expect(available(device)).toContain("copy-ip");
      expect(available(device)).toContain("copy-row");
      expect(available(device)).toContain("copy-details");
      expect(available(device)).toContain("ping");
      expect(available(device)).toContain("ping-console");
      expect(available(device)).toContain("traceroute");
    }
  });

  it("disable Copy hostname and Copy MAC when there is nothing to copy", () => {
    expect(action(SILENT_PRINTER, "copy-hostname").available).toBe(false);
    expect(action(SILENT_PRINTER, "copy-mac").available).toBe(true);

    const routed = host({ ip: "203.0.113.9", open_ports: [443], latency_ms: 24 });
    expect(action(routed, "copy-mac").available).toBe(false);
    expect(action(routed, "copy-mac").hint).toMatch(/own network segment/);
  });
});

describe("the menu never changes shape", () => {
  it("lists exactly the same actions for every device", () => {
    const shape = (h: HostResult) => deviceActions(h).map((a) => a.id);
    const reference = shape(WINDOWS_SERVER);
    for (const device of [SILENT_PRINTER, PRINTER, ACCESS_POINT, IP_CAMERA, NAS]) {
      expect(shape(device)).toEqual(reference);
    }
  });

  it("groups Connect first, then Diagnose, then Copy", () => {
    const groups = deviceActions(WINDOWS_SERVER).map((a) => a.group);
    const firstDiagnostic = groups.indexOf("diagnostics");
    const firstClipboard = groups.indexOf("clipboard");
    expect(groups.indexOf("connect")).toBe(0);
    expect(firstDiagnostic).toBeGreaterThan(0);
    expect(firstClipboard).toBeGreaterThan(firstDiagnostic);
  });

  it("gives every action a hint, available or not", () => {
    for (const a of deviceActions(SILENT_PRINTER)) {
      expect(a.hint.length).toBeGreaterThan(0);
    }
  });
});

describe("Copy cell", () => {
  it("appears only when a cell was right-clicked, and names that column", () => {
    expect(deviceActions(WINDOWS_SERVER).find((a) => a.id === "copy-cell")).toBeUndefined();

    const withCell = deviceActions(WINDOWS_SERVER, { cellColumn: "mac" });
    const cell = withCell.find((a) => a.id === "copy-cell");
    expect(cell?.label).toBe("Copy mac address");
    expect(cell?.column).toBe("mac");

    expect(
      deviceActions(WINDOWS_SERVER, { cellColumn: "status" }).find((a) => a.id === "copy-cell")
        ?.label,
    ).toBe("Copy status");
  });

  it("is the first item under Copy, where the pointer already is", () => {
    const clipboard = actionsInGroup(WINDOWS_SERVER, "clipboard", { cellColumn: "ip" });
    expect(clipboard[0]?.id).toBe("copy-cell");
  });
});

describe("Copy row with a selection", () => {
  it("says how many rows it will copy", () => {
    const one = deviceActions(WINDOWS_SERVER, { selectionCount: 1 });
    expect(one.find((a) => a.id === "copy-row")?.label).toBe("Copy row");

    const many = deviceActions(WINDOWS_SERVER, { selectionCount: 5 });
    expect(many.find((a) => a.id === "copy-row")?.label).toBe("Copy 5 selected rows");
  });
});

describe("primaryAction", () => {
  it("picks what somebody opens that kind of device to do", () => {
    // Remote control beats file sharing beats a management page.
    expect(primaryAction(WINDOWS_SERVER)?.id).toBe("rdp");
    expect(primaryAction(WORKSTATION)?.id).toBe("rdp");
    expect(primaryAction(NAS)?.id).toBe("ssh");
    expect(primaryAction(ACCESS_POINT)?.id).toBe("ssh");
    expect(primaryAction(PRINTER)?.id).toBe("web");
    expect(primaryAction(IP_CAMERA)?.id).toBe("web");
    expect(primaryAction(host({ ip: "10.0.0.1", open_ports: [445] }))?.id).toBe("smb");
    expect(primaryAction(host({ ip: "10.0.0.1", open_ports: [5900] }))?.id).toBe("vnc");
  });

  it("returns nothing for a device with nowhere to go", () => {
    expect(primaryAction(SILENT_PRINTER)).toBeNull();
    expect(primaryAction(host({ ip: "10.0.0.1", open_ports: [53, 515] }))).toBeNull();
  });
});
