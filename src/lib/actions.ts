// Which technician actions make sense for a given device.
//
// Every action is always listed, so the menu does not change shape from device
// to device and nothing a technician learned moves. Only the ones the device's
// open services actually support are enabled, and a disabled action says why
// rather than failing after the click.

import { smbPort, vncPort, webPort } from "./format";
import { COLUMN_BY_KEY, type ColumnKey } from "./table";
import type { HostResult } from "../types";

export type ActionId =
  | "copy-cell"
  | "copy-ip"
  | "copy-hostname"
  | "copy-mac"
  | "copy-row"
  | "copy-details"
  | "ping"
  | "ping-console"
  | "traceroute"
  | "web"
  | "smb"
  | "rdp"
  | "ssh"
  | "vnc";

export type ActionGroup = "clipboard" | "diagnostics" | "connect";

export interface DeviceAction {
  id: ActionId;
  label: string;
  group: ActionGroup;
  /** True when this device supports the action. */
  available: boolean;
  /** What it will do, or why it is unavailable. Shown as the tooltip. */
  hint: string;
  /** The port the action will use, where one applies. */
  port?: number;
  /** The column a Copy cell action refers to. */
  column?: ColumnKey;
}

export interface ActionContext {
  /**
   * The column that was right-clicked, when the action list is for a context
   * menu. Adds Copy cell, which is the fastest way to get one value out of a
   * dense table.
   */
  cellColumn?: ColumnKey;
  /** How many rows are selected, so Copy row can say what it will copy. */
  selectionCount?: number;
}

/**
 * Build the action list for a device.
 *
 * The clipboard and diagnostic actions need only an address, which every
 * device has. Everything under Connect needs evidence that the service is
 * there: offering Remote Desktop for a device with 3389 closed would waste a
 * technician's time twice, once clicking and once waiting for the timeout.
 */
export function deviceActions(host: HostResult, ctx: ActionContext = {}): DeviceAction[] {
  const ports = host.open_ports;
  const web = webPort(ports);
  const smb = smbPort(ports);
  const vnc = vncPort(ports);
  const rdp = ports.includes(3389);
  const ssh = ports.includes(22);
  const hostname = host.hostname?.trim();
  const mac = host.mac?.trim();
  const selection = ctx.selectionCount ?? 0;

  const connect: DeviceAction[] = [
    {
      id: "web",
      label: "Open web interface",
      group: "connect",
      available: web != null,
      hint: web != null ? `Open port ${web} in your browser` : "No web service found",
      ...(web != null ? { port: web } : {}),
    },
    {
      id: "smb",
      label: "Open file shares",
      group: "connect",
      available: smb != null,
      hint: smb != null ? `Open \\\\${host.ip} in File Explorer` : "No file sharing found",
      ...(smb != null ? { port: smb } : {}),
    },
    {
      id: "rdp",
      label: "Open Remote Desktop",
      group: "connect",
      available: rdp,
      hint: rdp ? "Connect with Remote Desktop on port 3389" : "Port 3389 is not open",
      ...(rdp ? { port: 3389 } : {}),
    },
    {
      id: "ssh",
      label: "Open SSH",
      group: "connect",
      available: ssh,
      hint: ssh ? "Open an SSH session on port 22" : "Port 22 is not open",
      ...(ssh ? { port: 22 } : {}),
    },
    {
      id: "vnc",
      label: "Open VNC",
      group: "connect",
      available: vnc != null,
      hint: vnc != null ? `Open port ${vnc} in your VNC viewer` : "No VNC service found",
      ...(vnc != null ? { port: vnc } : {}),
    },
  ];

  const diagnostics: DeviceAction[] = [
    {
      id: "ping",
      label: "Ping",
      group: "diagnostics",
      available: true,
      hint: "Ping once and show the result in the details panel",
    },
    {
      id: "ping-console",
      label: "Ping in a command prompt",
      group: "diagnostics",
      available: true,
      hint: "Open a command prompt running a continuous ping",
    },
    {
      id: "traceroute",
      label: "Traceroute",
      group: "diagnostics",
      available: true,
      hint: "Open a command prompt running a traceroute",
    },
  ];

  const clipboard: DeviceAction[] = [];
  if (ctx.cellColumn) {
    const column = COLUMN_BY_KEY[ctx.cellColumn];
    const name = column.label || "Status";
    clipboard.push({
      id: "copy-cell",
      label: `Copy ${name.toLowerCase()}`,
      group: "clipboard",
      available: true,
      hint: `Copy just the ${name.toLowerCase()} of this device`,
      column: ctx.cellColumn,
    });
  }
  clipboard.push(
    {
      id: "copy-ip",
      label: "Copy IP address",
      group: "clipboard",
      available: true,
      hint: `Copy ${host.ip}`,
    },
    {
      id: "copy-hostname",
      label: "Copy hostname",
      group: "clipboard",
      available: Boolean(hostname),
      hint: hostname ? `Copy ${hostname}` : "This device has no hostname",
    },
    {
      id: "copy-mac",
      label: "Copy MAC address",
      group: "clipboard",
      available: Boolean(mac),
      hint: mac
        ? `Copy ${mac}`
        : "A MAC address is only visible for devices on your own network segment",
    },
    {
      id: "copy-row",
      label: selection > 1 ? `Copy ${selection} selected rows` : "Copy row",
      group: "clipboard",
      available: true,
      hint:
        selection > 1
          ? `Copy the ${selection} selected rows, tab separated`
          : "Copy this row, tab separated for pasting into a ticket or spreadsheet",
    },
    {
      id: "copy-details",
      label: "Copy all details",
      group: "clipboard",
      available: true,
      hint: "Copy every field for this device as a readable block",
    },
  );

  return [...connect, ...diagnostics, ...clipboard];
}

/**
 * The one action a technician most likely wants for this device.
 *
 * Ordered by what someone opens a device to do: take control of it, reach its
 * files, then look at its management page.
 */
export function primaryAction(host: HostResult): DeviceAction | null {
  const actions = deviceActions(host);
  for (const id of ["rdp", "ssh", "smb", "web", "vnc"] as ActionId[]) {
    const action = actions.find((a) => a.id === id);
    if (action?.available) return action;
  }
  return null;
}

/** The actions in one group, for rendering a menu section. */
export function actionsInGroup(
  host: HostResult,
  group: ActionGroup,
  ctx: ActionContext = {},
): DeviceAction[] {
  return deviceActions(host, ctx).filter((a) => a.group === group);
}
