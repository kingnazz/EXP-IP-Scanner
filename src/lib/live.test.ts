import { describe, expect, it } from "vitest";
import { host, SILENT_PRINTER, THIS_COMPUTER, WINDOWS_SERVER } from "../test/devices";
import {
  hasServices,
  isResponding,
  isStaleEvent,
  removeHostByIp,
  rowName,
  rowsFromResult,
  settleRows,
  upsertHost,
  type DeviceRow,
} from "./live";

describe("upsertHost", () => {
  it("adds a device the table has not seen", () => {
    const rows = upsertHost([], WINDOWS_SERVER, true);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.host.ip).toBe(WINDOWS_SERVER.ip);
    expect(rows[0]?.pending).toBe(true);
  });

  it("merges a second report of the same address instead of duplicating it", () => {
    // The scanner reports a device once when it answers and again when its
    // name and manufacturer resolve. That must be one row, not two.
    const discovered = host({
      ip: "192.168.50.10",
      open_ports: [445, 3389],
      latency_ms: 0.62,
      ttl: 128,
    });
    const enriched = host({
      ip: "192.168.50.10",
      hostname: "dc01.exp.local",
      mac: "00:15:5D:3A:91:22",
      vendor: "Microsoft",
      open_ports: [445, 3389],
      latency_ms: 0.62,
      ttl: 128,
    });

    let rows = upsertHost([], discovered, true);
    rows = upsertHost(rows, enriched, false);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.host.hostname).toBe("dc01.exp.local");
    expect(rows[0]?.host.mac).toBe("00:15:5D:3A:91:22");
    expect(rows[0]?.host.vendor).toBe("Microsoft");
    expect(rows[0]?.pending).toBe(false);
  });

  it("never loses a fact to a later event that does not carry it", () => {
    // The hostname arrives mid-scan and the MAC only at the end, so each
    // update is missing what the other found. Replacing rather than merging
    // would drop one of them.
    const base = host({ ip: "10.0.0.5", open_ports: [80], latency_ms: 2 });
    let rows = upsertHost([], base, true);
    rows = upsertHost(rows, { ...base, hostname: "printer.local" }, true);
    rows = upsertHost(rows, { ...base, mac: "00:80:77:41:C2:8E", vendor: "Brother" }, true);

    expect(rows[0]?.host.hostname).toBe("printer.local");
    expect(rows[0]?.host.mac).toBe("00:80:77:41:C2:8E");
    expect(rows[0]?.host.vendor).toBe("Brother");
  });

  it("survives events arriving out of order", () => {
    // The final update lands before a slow intermediate one. The intermediate
    // event carries no MAC, and must not erase the one already known.
    const base = host({ ip: "10.0.0.6", open_ports: [22], latency_ms: 1 });
    let rows = upsertHost([], base, true);
    rows = upsertHost(rows, { ...base, hostname: "nas.local", mac: "AA:BB:CC:00:11:22" }, false);
    rows = upsertHost(rows, { ...base, hostname: "nas.local" }, true);

    expect(rows[0]?.host.mac).toBe("AA:BB:CC:00:11:22");
    // And a row that has settled stays settled.
    expect(rows[0]?.pending).toBe(false);
  });

  it("keeps the open ports a discovery found when a later event omits them", () => {
    const discovered = host({ ip: "10.0.0.7", open_ports: [22, 80, 443], latency_ms: 1 });
    const nameOnly = host({ ip: "10.0.0.7", hostname: "ap.local" });
    const rows = upsertHost(upsertHost([], discovered, true), nameOnly, true);
    expect(rows[0]?.host.open_ports).toEqual([22, 80, 443]);
  });

  it("does not mutate the array it was given", () => {
    const rows: DeviceRow[] = [{ host: WINDOWS_SERVER, pending: false }];
    const snapshot = [...rows];
    upsertHost(rows, THIS_COMPUTER, true);
    expect(rows).toEqual(snapshot);
  });

  it("keeps the order devices were found in", () => {
    let rows = upsertHost([], host({ ip: "10.0.0.30" }), true);
    rows = upsertHost(rows, host({ ip: "10.0.0.4" }), true);
    rows = upsertHost(rows, host({ ip: "10.0.0.30", hostname: "later.local" }), false);
    // Merging an existing device updates it in place rather than moving it,
    // which is what stops rows jumping under the pointer mid-scan.
    expect(rows.map((r) => r.host.ip)).toEqual(["10.0.0.30", "10.0.0.4"]);
  });
});

describe("removeHostByIp", () => {
  it("withdraws a device the scanner decided was not real", () => {
    // A proxy-ARP responder makes an address look occupied; the scanner
    // retracts it, and the live table has to agree with the saved result.
    let rows = upsertHost([], WINDOWS_SERVER, false);
    rows = upsertHost(rows, THIS_COMPUTER, false);
    rows = removeHostByIp(rows, WINDOWS_SERVER.ip);
    expect(rows.map((r) => r.host.ip)).toEqual([THIS_COMPUTER.ip]);
  });

  it("is a no-op for an address the table never had", () => {
    const rows = upsertHost([], WINDOWS_SERVER, false);
    expect(removeHostByIp(rows, "10.9.9.9")).toBe(rows);
  });
});

describe("settleRows", () => {
  it("clears every pending row when a scan ends", () => {
    const rows = settleRows([
      { host: WINDOWS_SERVER, pending: true },
      { host: THIS_COMPUTER, pending: true },
    ]);
    expect(rows.every((r) => !r.pending)).toBe(true);
  });

  it("returns the same array when there is nothing to settle", () => {
    const rows: DeviceRow[] = [{ host: WINDOWS_SERVER, pending: false }];
    expect(settleRows(rows)).toBe(rows);
  });
});

describe("isStaleEvent", () => {
  it("drops events from a scan the table is no longer showing", () => {
    // The case this prevents: a stopped scan finishing in the background and
    // injecting its devices into the next one's results.
    expect(isStaleEvent(7, 7)).toBe(false);
    expect(isStaleEvent(6, 7)).toBe(true);
    expect(isStaleEvent(8, 7)).toBe(true);
  });

  it("drops everything before a scan has claimed the table", () => {
    expect(isStaleEvent(1, null)).toBe(true);
  });
});

describe("row helpers", () => {
  it("names a device by its hostname, and by its address when it has none", () => {
    expect(rowName({ host: WINDOWS_SERVER, pending: false })).toBe("dc01.exp.local");
    expect(rowName({ host: SILENT_PRINTER, pending: false })).toBe(SILENT_PRINTER.ip);
    // A hostname of only whitespace is not a name.
    expect(rowName({ host: host({ ip: "10.0.0.1", hostname: "   " }), pending: false })).toBe(
      "10.0.0.1",
    );
  });

  it("tells a device that answered apart from one found only through ARP", () => {
    expect(isResponding({ host: WINDOWS_SERVER, pending: false })).toBe(true);
    expect(isResponding({ host: SILENT_PRINTER, pending: false })).toBe(false);
  });

  it("knows which devices exposed a service", () => {
    expect(hasServices({ host: WINDOWS_SERVER, pending: false })).toBe(true);
    expect(hasServices({ host: SILENT_PRINTER, pending: false })).toBe(false);
  });

  it("builds settled rows from a finished result", () => {
    const rows = rowsFromResult([WINDOWS_SERVER, SILENT_PRINTER]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => !r.pending)).toBe(true);
  });
});
