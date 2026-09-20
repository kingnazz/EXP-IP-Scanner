import { describe, expect, it } from "vitest";
import {
  ALL_ROWS,
  ETHERNET,
  SILENT_PRINTER,
  WINDOWS_SERVER,
  host,
  row,
} from "../test/devices";
import {
  buildClipboardTable,
  buildCsv,
  buildDeviceDetails,
  buildIpList,
  buildNetworkSummary,
  csvFilename,
} from "./export";

const ctx = { target: "192.168.50.0/24", scannedAt: "2026-09-18T09:30:00.000Z" };

describe("buildCsv", () => {
  const csv = buildCsv(ALL_ROWS, ctx);
  const lines = csv.replace(/^﻿/, "").trimEnd().split("\r\n");

  it("starts with a UTF-8 byte-order mark so Excel reads it correctly", () => {
    // Without it, Excel on Windows reads a UTF-8 file as the local code page
    // and mangles any manufacturer name with an accent in it.
    expect(csv.startsWith("﻿")).toBe(true);
  });

  it("uses CRLF line endings, which is what Windows tools expect", () => {
    expect(csv).toContain("\r\n");
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("has a header row and one row per device", () => {
    expect(lines).toHaveLength(ALL_ROWS.length + 1);
    expect(lines[0]).toBe(
      "IP Address,Hostname,MAC Address,Manufacturer,Latency (ms),Open Ports,Services," +
        "Device Type Guess,Status,Scan Target,Scan Time",
    );
  });

  it("carries every field a technician needs, and the scan context on each row", () => {
    const server = lines.find((l) => l.startsWith("192.168.50.10,"));
    expect(server).toBeDefined();
    expect(server).toContain("dc01.exp.local");
    expect(server).toContain("00:15:5D:3A:91:22");
    expect(server).toContain("Microsoft");
    expect(server).toContain("0.62");
    expect(server).toContain("3389");
    expect(server).toContain("RDP");
    expect(server).toContain("192.168.50.0/24");
    expect(server).toContain("2026-09-18T09:30:00.000Z");
  });

  it("leaves a cell empty rather than writing a dash for a missing value", () => {
    // A dash in a spreadsheet is a value; an empty cell is the absence.
    const quiet = lines.find((l) => l.startsWith(`${SILENT_PRINTER.ip},`));
    expect(quiet).toBe(
      `${SILENT_PRINTER.ip},,00:00:AA:1D:42:07,Xerox,,,,,Quiet,192.168.50.0/24,` +
        "2026-09-18T09:30:00.000Z",
    );
  });

  it("quotes a value containing a comma or a quote", () => {
    const awkward = buildCsv(
      [row({ ip: "10.0.0.1", vendor: 'Aruba, a "HPE" Company' })],
      ctx,
    );
    expect(awkward).toContain('"Aruba, a ""HPE"" Company"');
  });

  it("never lets a hostname become a spreadsheet formula", () => {
    // A hostname comes off an untrusted network. A leading = or + is how a CSV
    // turns into code the moment somebody opens it.
    const hostile = buildCsv(
      [row({ ip: "10.0.0.2", hostname: '=HYPERLINK("http://evil","click")' })],
      ctx,
    );
    expect(hostile).not.toMatch(/,=HYPERLINK/);
    expect(hostile).toContain("'=HYPERLINK");

    for (const prefix of ["=", "+", "-", "@"]) {
      const csvText = buildCsv([row({ ip: "10.0.0.3", vendor: `${prefix}cmd` })], ctx);
      expect(csvText).toContain(`'${prefix}cmd`);
    }
  });

  it("produces only a header when there is nothing to export", () => {
    const empty = buildCsv([], ctx).replace(/^﻿/, "").trimEnd();
    expect(empty.split("\r\n")).toHaveLength(1);
  });
});

describe("buildClipboardTable", () => {
  it("is tab separated, so it pastes into a spreadsheet as columns", () => {
    const text = buildClipboardTable([{ host: WINDOWS_SERVER, pending: false }]);
    const [header, first] = text.split("\n");
    expect(header?.split("\t")).toHaveLength(9);
    expect(first?.split("\t")[0]).toBe("192.168.50.10");
    expect(first?.split("\t")[1]).toBe("dc01.exp.local");
  });

  it("carries no scan-context columns, which a paste does not need", () => {
    const text = buildClipboardTable(ALL_ROWS);
    expect(text).not.toContain("192.168.50.0/24");
    expect(text.split("\n")).toHaveLength(ALL_ROWS.length + 1);
  });

  it("flattens anything that would break the paste into a table", () => {
    const text = buildClipboardTable([
      row({ ip: "10.0.0.1", hostname: "two\tcolumns\nand a row" }),
    ]);
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toContain("two columns and a row");
  });
});

describe("buildIpList", () => {
  it("copies only IP addresses, one per line", () => {
    expect(buildIpList(ALL_ROWS)).toBe(ALL_ROWS.map((row) => row.host.ip).join("\n"));
  });

  it("returns an empty string for no rows", () => {
    expect(buildIpList([])).toBe("");
  });
});

describe("buildNetworkSummary", () => {
  it("copies the five network facts a technician puts in a ticket", () => {
    expect(
      buildNetworkSummary({
        network: ETHERNET,
        target: "192.168.50.0/24",
        addressCount: 254,
        publicIp: "203.0.113.44",
      }),
    ).toBe(
      [
        "Adapter      Ethernet",
        "Local IP     192.168.50.37",
        "Gateway      192.168.50.1",
        "Scan range   192.168.50.0/24 (254 addresses)",
        "Public IP    203.0.113.44",
      ].join("\n"),
    );
  });

  it("stays useful when adapter or public-IP data is unavailable", () => {
    const text = buildNetworkSummary({
      network: null,
      target: "10.0.0.5",
      addressCount: 1,
      publicIp: "Unavailable",
    });
    expect(text).toContain("Adapter      Not detected");
    expect(text).toContain("Local IP     Unavailable");
    expect(text).toContain("Gateway      None");
    expect(text).toContain("Scan range   10.0.0.5 (1 address)");
    expect(text).toContain("Public IP    Unavailable");
  });
});

describe("buildDeviceDetails", () => {
  it("reads as a block somebody can paste into a ticket", () => {
    const text = buildDeviceDetails({ host: WINDOWS_SERVER, pending: false });
    expect(text).toContain("IP address    192.168.50.10");
    expect(text).toContain("Hostname      dc01.exp.local");
    expect(text).toContain("MAC address   00:15:5D:3A:91:22");
    expect(text).toContain("Manufacturer  Microsoft");
    expect(text).toContain("Latency       0.62 ms");
    expect(text).toContain("TTL           128");
    expect(text).toContain("3389 RDP");
    // The guess is labelled as one.
    expect(text).toContain("(estimated)");
  });

  it("omits a field the device does not have rather than showing it empty", () => {
    const text = buildDeviceDetails({ host: SILENT_PRINTER, pending: false });
    expect(text).not.toContain("Hostname");
    expect(text).not.toContain("Latency");
    expect(text).toContain("MAC address   00:00:AA:1D:42:07");
    expect(text).toContain("Open ports    none found");
  });
});

describe("csvFilename", () => {
  const when = new Date(2026, 8, 18, 9, 30);

  it("says what was scanned and when", () => {
    expect(csvFilename("192.168.50.0/24", when)).toBe(
      "exp-ip-scanner-192.168.50.0_24-20260918-0930.csv",
    );
  });

  it("keeps a range readable", () => {
    expect(csvFilename("192.168.1.1-254", when)).toBe(
      "exp-ip-scanner-192.168.1.1-254-20260918-0930.csv",
    );
  });

  it("never produces a filename made of separators", () => {
    expect(csvFilename("///", when)).toBe("exp-ip-scanner-scan-20260918-0930.csv");
    expect(csvFilename("", when)).toBe("exp-ip-scanner-scan-20260918-0930.csv");
  });

  it("always ends in .csv, which is what the backend will accept", () => {
    for (const target of ["10.0.0.1", "10.0.0.0/8", "weird name", "", "../../etc/passwd"]) {
      const name = csvFilename(target, when);
      expect(name.endsWith(".csv")).toBe(true);
      expect(name).not.toContain("/");
      expect(name).not.toContain("\\");
      expect(name).not.toContain("..");
    }
  });
});

describe("the export and the table agree", () => {
  it("exports the same status word the table shows", () => {
    const csv = buildCsv(
      [{ host: host({ ip: "10.0.0.1", is_self: true }), pending: false }],
      ctx,
    );
    expect(csv).toContain("This computer");
  });
});
