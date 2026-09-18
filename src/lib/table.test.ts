import { describe, expect, it } from "vitest";
import {
  ACCESS_POINT,
  ALL_ROWS,
  FIREWALL,
  IP_CAMERA,
  NAS,
  PRINTER,
  SILENT_PRINTER,
  THIS_COMPUTER,
  WINDOWS_SERVER,
  WORKSTATION,
  row,
} from "../test/devices";
import {
  COLUMNS,
  DEFAULT_HIDDEN_COLUMNS,
  cellText,
  filterRows,
  prepareRows,
  searchHaystack,
  sortRows,
  visibleColumns,
  type ColumnKey,
} from "./table";

const rows = ALL_ROWS;
const ips = (list: { host: { ip: string } }[]) => list.map((r) => r.host.ip);

describe("sortRows by address", () => {
  it("orders addresses numerically", () => {
    // 192.168.50.9 must come before .10 and .100, which is exactly what a
    // string sort gets wrong and what every technician notices immediately.
    expect(ips(sortRows(rows, "ip", "asc"))).toEqual([
      "192.168.50.1",
      "192.168.50.9",
      "192.168.50.10",
      "192.168.50.26",
      "192.168.50.27",
      "192.168.50.31",
      "192.168.50.37",
      "192.168.50.51",
      "192.168.50.100",
    ]);
  });

  it("reverses exactly", () => {
    const asc = ips(sortRows(rows, "ip", "asc"));
    expect(ips(sortRows(rows, "ip", "desc"))).toEqual([...asc].reverse());
  });
});

describe("sortRows by other columns", () => {
  it("sorts hostnames alphabetically and puts the unnamed devices last", () => {
    const sorted = sortRows(rows, "hostname", "asc");
    const names = sorted.map((r) => r.host.hostname);
    const named = names.filter((n) => n != null);
    expect(named).toEqual([...named].sort((a, b) => a!.localeCompare(b!)));
    // The two devices with no hostname are at the end, in address order.
    expect(names.slice(-2)).toEqual([null, null]);
    expect(ips(sorted).slice(-2)).toEqual(["192.168.50.26", "192.168.50.51"]);
  });

  it("keeps unnamed devices last when the direction is reversed", () => {
    // A blank is an absence, not a value that sorts to the top when reversed.
    const desc = sortRows(rows, "hostname", "desc");
    expect(desc.slice(-2).map((r) => r.host.hostname)).toEqual([null, null]);
  });

  it("sorts latency ascending and puts non-responders last in both directions", () => {
    const asc = sortRows(rows, "latency", "asc");
    expect(asc[0]?.host.ip).toBe(THIS_COMPUTER.ip);
    expect(asc.at(-1)?.host.ip).toBe(SILENT_PRINTER.ip);
    const desc = sortRows(rows, "latency", "desc");
    // Slowest first, and the device that answered nothing still last.
    expect(desc[0]?.host.ip).toBe(IP_CAMERA.ip);
    expect(desc.at(-1)?.host.ip).toBe(SILENT_PRINTER.ip);
  });

  it("sorts manufacturers and leaves the unknown ones last", () => {
    const vendors = sortRows(
      [...rows, row({ ip: "192.168.50.200" })],
      "vendor",
      "asc",
    ).map((r) => r.host.vendor);
    expect(vendors.at(-1)).toBeNull();
  });

  it("sorts by how many services a device exposes", () => {
    const asc = sortRows(rows, "ports", "asc");
    expect(asc[0]?.host.ip).toBe(SILENT_PRINTER.ip);
    expect(asc.at(-1)?.host.ip).toBe(WINDOWS_SERVER.ip);
  });

  it("puts this computer and the busiest devices first in the status column", () => {
    const sorted = sortRows(rows, "status", "asc");
    expect(sorted[0]?.host.ip).toBe(THIS_COMPUTER.ip);
    // The device that answered nothing sorts last.
    expect(sorted.at(-1)?.host.ip).toBe(SILENT_PRINTER.ip);
  });
});

describe("sort stability", () => {
  it("breaks ties by address, so streaming rows never reshuffle", () => {
    // Three devices with identical latency: their relative order has to be
    // decided by something, or every new row re-randomises the table.
    const tied = [
      row({ ip: "192.168.1.30", latency_ms: 2 }),
      row({ ip: "192.168.1.4", latency_ms: 2 }),
      row({ ip: "192.168.1.200", latency_ms: 2 }),
    ];
    expect(ips(sortRows(tied, "latency", "asc"))).toEqual([
      "192.168.1.4",
      "192.168.1.30",
      "192.168.1.200",
    ]);
    // And the same order when reversed, because the tiebreak is not inverted.
    expect(ips(sortRows(tied, "latency", "desc"))).toEqual([
      "192.168.1.4",
      "192.168.1.30",
      "192.168.1.200",
    ]);
  });

  it("does not mutate the array it was given", () => {
    const original = [...rows];
    sortRows(rows, "latency", "desc");
    expect(rows).toEqual(original);
  });
});

describe("search", () => {
  // Sorted, because `filterRows` deliberately preserves the order it was
  // given -- the sort is a separate step -- and these assertions are about
  // which devices matched.
  const find = (query: string) => ips(sortRows(filterRows(rows, "all", query), "ip", "asc"));

  it("matches an address, whole or partial", () => {
    expect(find("192.168.50.10")).toEqual([WINDOWS_SERVER.ip, NAS.ip]);
    expect(find("192.168.50.100")).toEqual([NAS.ip]);
    expect(find(".51")).toEqual([IP_CAMERA.ip]);
  });

  it("matches a hostname", () => {
    expect(find("dc01")).toEqual([WINDOWS_SERVER.ip]);
    expect(find("nas-backup")).toEqual([NAS.ip]);
  });

  it("matches a MAC address, in any case", () => {
    expect(find("94:57:a5")).toEqual([PRINTER.ip]);
    expect(find("94:57:A5:13:6B:02")).toEqual([PRINTER.ip]);
  });

  it("matches a manufacturer", () => {
    expect(find("ubiquiti")).toEqual([FIREWALL.ip, ACCESS_POINT.ip]);
    expect(find("xerox")).toEqual([SILENT_PRINTER.ip]);
  });

  it("matches a port number and a service name equally", () => {
    expect(find("3389")).toEqual([WORKSTATION.ip, WINDOWS_SERVER.ip]);
    expect(find("rdp")).toEqual([WORKSTATION.ip, WINDOWS_SERVER.ip]);
    expect(find("9100")).toEqual([PRINTER.ip]);
    expect(find("print")).toEqual([PRINTER.ip]);
  });

  it("narrows with every extra term rather than widening", () => {
    expect(find("dell")).toEqual([]);
    expect(find("lenovo")).toHaveLength(2);
    expect(find("lenovo rdp")).toEqual([WORKSTATION.ip]);
    expect(find("lenovo nothing-matches-this")).toEqual([]);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(find("  UBIQUITI  ")).toEqual(find("ubiquiti"));
  });

  it("returns everything for an empty query", () => {
    expect(filterRows(rows, "all", "")).toHaveLength(rows.length);
    expect(filterRows(rows, "all", "   ")).toHaveLength(rows.length);
  });

  it("searches only what the technician can see", () => {
    const hay = searchHaystack({ host: WINDOWS_SERVER, pending: false });
    expect(hay).toContain("dc01.exp.local");
    expect(hay).toContain("00:15:5d:3a:91:22");
    expect(hay).toContain("microsoft");
    expect(hay).toContain("3389");
    expect(hay).toContain("rdp");
    // The scan timestamp is not something anyone searches for.
    expect(hay).not.toContain("2026-09-18");
  });
});

describe("filters", () => {
  it("All shows every device found", () => {
    expect(filterRows(rows, "all", "")).toHaveLength(rows.length);
  });

  it("Responding excludes a device found only through ARP", () => {
    const responding = ips(filterRows(rows, "responding", ""));
    expect(responding).not.toContain(SILENT_PRINTER.ip);
    expect(responding).toHaveLength(rows.length - 1);
  });

  it("Has services excludes a device with no open ports", () => {
    const withServices = ips(filterRows(rows, "services", ""));
    expect(withServices).not.toContain(SILENT_PRINTER.ip);
  });

  it("combines with the search", () => {
    expect(ips(filterRows(rows, "responding", "xerox"))).toEqual([]);
    expect(ips(filterRows(rows, "services", "hikvision"))).toEqual([IP_CAMERA.ip]);
  });
});

describe("prepareRows", () => {
  it("filters first and then sorts, as the table renders it", () => {
    const prepared = prepareRows(rows, "services", "ubiquiti", "ip", "asc");
    expect(ips(prepared)).toEqual([FIREWALL.ip, ACCESS_POINT.ip]);
  });
});

describe("columns", () => {
  it("always shows the columns a row is meaningless without", () => {
    const visible = visibleColumns(["ip", "hostname", "status", "mac", "vendor"] as ColumnKey[]);
    const keys = visible.map((c) => c.key);
    // Required columns cannot be switched off, even if the stored preferences
    // ask for it.
    expect(keys).toContain("status");
    expect(keys).toContain("ip");
    expect(keys).toContain("hostname");
    expect(keys).not.toContain("mac");
    expect(keys).not.toContain("vendor");
  });

  it("hides the device-type guess until it is asked for", () => {
    expect(DEFAULT_HIDDEN_COLUMNS).toEqual(["os"]);
    expect(visibleColumns(DEFAULT_HIDDEN_COLUMNS).map((c) => c.key)).not.toContain("os");
  });

  it("gives every column a usable minimum and a starting width", () => {
    for (const column of COLUMNS) {
      expect(column.minWidth).toBeGreaterThan(0);
      expect(column.width).toBeGreaterThanOrEqual(column.minWidth);
    }
  });

  it("marks exactly one column flexible, and it is the last one", () => {
    const flexible = COLUMNS.filter((c) => c.flexible);
    expect(flexible).toHaveLength(1);
    expect(COLUMNS.at(-1)?.key).toBe(flexible[0]?.key);
  });
});

describe("cellText", () => {
  it("returns what the cell shows, for Copy cell and the export", () => {
    const serverRow = { host: WINDOWS_SERVER, pending: false };
    expect(cellText(serverRow, "ip")).toBe("192.168.50.10");
    expect(cellText(serverRow, "hostname")).toBe("dc01.exp.local");
    expect(cellText(serverRow, "mac")).toBe("00:15:5D:3A:91:22");
    expect(cellText(serverRow, "vendor")).toBe("Microsoft");
    expect(cellText(serverRow, "latency")).toBe("0.62");
    expect(cellText(serverRow, "ports")).toContain("3389 RDP");
    expect(cellText(serverRow, "status")).toBe("Responding");
  });

  it("returns an empty string rather than a dash for an absent value", () => {
    const quiet = { host: SILENT_PRINTER, pending: false };
    expect(cellText(quiet, "hostname")).toBe("");
    expect(cellText(quiet, "latency")).toBe("");
    expect(cellText(quiet, "ports")).toBe("");
    expect(cellText(quiet, "status")).toBe("Quiet");
  });

  it("names this computer in the status column", () => {
    expect(cellText({ host: THIS_COMPUTER, pending: false }, "status")).toBe("This computer");
  });
});
