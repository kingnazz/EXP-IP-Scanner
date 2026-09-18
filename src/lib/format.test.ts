import { describe, expect, it } from "vitest";
import {
  formatCount,
  formatDuration,
  formatLatency,
  ipToNum,
  isActionablePort,
  parsePorts,
  phaseLabel,
  portWithService,
  serviceLabel,
  serviceName,
  setServiceCatalog,
  smbPort,
  vncPort,
  webPort,
} from "./format";

describe("ipToNum", () => {
  it("orders addresses numerically, not as text", () => {
    // The mistake this exists to prevent: string order puts .100 before .9.
    expect(ipToNum("192.168.1.9")).toBeLessThan(ipToNum("192.168.1.100"));
    expect(ipToNum("192.168.1.2")).toBeLessThan(ipToNum("192.168.1.10"));
    expect(ipToNum("10.0.0.255")).toBeLessThan(ipToNum("10.0.1.0"));
    expect(ipToNum("9.255.255.255")).toBeLessThan(ipToNum("10.0.0.0"));
  });

  it("covers the whole address space without overflowing", () => {
    expect(ipToNum("0.0.0.0")).toBe(0);
    expect(ipToNum("255.255.255.255")).toBe(4294967295);
    expect(ipToNum("192.168.1.1")).toBe(3232235777);
  });

  it("treats malformed input as zero rather than NaN", () => {
    // NaN would make every comparison false and silently unsort the table.
    for (const bad of ["", "not-an-ip", "1.2.3", "1.2.3.4.5"]) {
      expect(Number.isFinite(ipToNum(bad))).toBe(true);
    }
  });
});

describe("formatLatency", () => {
  it("keeps precision where it distinguishes a link, and drops it where it does not", () => {
    expect(formatLatency(0.11)).toBe("0.11 ms");
    expect(formatLatency(0.84)).toBe("0.84 ms");
    expect(formatLatency(1.6)).toBe("1.6 ms");
    expect(formatLatency(9.94)).toBe("9.9 ms");
    expect(formatLatency(42.4)).toBe("42 ms");
    expect(formatLatency(310)).toBe("310 ms");
  });

  it("returns null for a device that answered nothing", () => {
    expect(formatLatency(null)).toBeNull();
    expect(formatLatency(undefined)).toBeNull();
    expect(formatLatency(Number.NaN)).toBeNull();
    expect(formatLatency(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("formatDuration", () => {
  it("reads the way the completion line should", () => {
    expect(formatDuration(420)).toBe("420 ms");
    expect(formatDuration(4_800)).toBe("4.8 sec");
    expect(formatDuration(59_400)).toBe("59.4 sec");
    expect(formatDuration(72_000)).toBe("1m 12s");
    expect(formatDuration(600_000)).toBe("10m 00s");
  });

  it("never renders a nonsense duration", () => {
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
  });
});

describe("service names", () => {
  it("names the ports the default scan probes", () => {
    expect(serviceName(22)).toBe("SSH");
    expect(serviceName(3389)).toBe("RDP");
    expect(serviceName(445)).toBe("SMB");
    expect(serviceName(9100)).toBe("Print");
    expect(serviceName(5985)).toBe("WinRM");
  });

  it("falls back to the number rather than showing an empty cell", () => {
    expect(serviceName(64999)).toBeNull();
    expect(serviceLabel(64999)).toBe("64999");
    expect(portWithService(64999)).toBe("64999");
    expect(portWithService(443)).toBe("443 HTTPS");
  });

  it("takes the backend's catalog when it arrives", () => {
    setServiceCatalog([{ port: 64999, name: "Something New" }]);
    expect(serviceName(64999)).toBe("Something New");
    // An empty catalog is ignored rather than wiping the table's vocabulary.
    setServiceCatalog([]);
    expect(serviceName(64999)).toBe("Something New");
  });
});

describe("action ports", () => {
  it("prefers HTTPS, then the ordinary management ports", () => {
    expect(webPort([80, 443])).toBe(443);
    expect(webPort([80, 8443])).toBe(8443);
    expect(webPort([80, 8080])).toBe(80);
    expect(webPort([8080])).toBe(8080);
    expect(webPort([9100])).toBe(9100);
    expect(webPort([22, 445])).toBeNull();
  });

  it("prefers SMB over the legacy NetBIOS port", () => {
    expect(smbPort([139, 445])).toBe(445);
    expect(smbPort([139])).toBe(139);
    expect(smbPort([135])).toBeNull();
  });

  it("finds a VNC display on any of the usual ports", () => {
    expect(vncPort([5900])).toBe(5900);
    expect(vncPort([5901])).toBe(5901);
    expect(vncPort([22])).toBeNull();
  });

  it("emphasises the ports that lead somewhere", () => {
    expect(isActionablePort(3389)).toBe(true);
    expect(isActionablePort(445)).toBe(true);
    expect(isActionablePort(22)).toBe(true);
    expect(isActionablePort(53)).toBe(false);
    expect(isActionablePort(515)).toBe(false);
  });
});

describe("parsePorts", () => {
  it("accepts the forms a technician types", () => {
    expect(parsePorts("443").ports).toEqual([443]);
    expect(parsePorts("22,80,443").ports).toEqual([22, 80, 443]);
    expect(parsePorts("22 80 443").ports).toEqual([22, 80, 443]);
    expect(parsePorts("80-82").ports).toEqual([80, 81, 82]);
    expect(parsePorts("443, 80-82, 22").ports).toEqual([22, 80, 81, 82, 443]);
    // A reversed range is what was meant, in the wrong order.
    expect(parsePorts("82-80").ports).toEqual([80, 81, 82]);
  });

  it("de-duplicates and sorts", () => {
    expect(parsePorts("443,80,443,80-81").ports).toEqual([80, 81, 443]);
  });

  it("reports what is wrong, in the words the backend uses", () => {
    expect(parsePorts("0").error).toMatch(/1 to 65535/);
    expect(parsePorts("65536").error).toMatch(/1 to 65535/);
    expect(parsePorts("http").error).toMatch(/not a port number/);
    expect(parsePorts("80,http").error).toMatch(/not a port number/);
    expect(parsePorts("1-65535").error).toMatch(/1024 port limit/);
  });

  it("treats an empty field as the defaults rather than an error", () => {
    expect(parsePorts("")).toEqual({ ports: [], error: null });
    expect(parsePorts("   ")).toEqual({ ports: [], error: null });
  });

  it("enforces the same cap the backend does, in the same words", () => {
    expect(parsePorts("1-1024").ports).toHaveLength(1024);
    // The backend's MAX_PORTS. Both sides say 1024 and phrase it identically,
    // so a technician never sees two versions of the same rule.
    expect(parsePorts("1-1024,3000").error).toBe(
      "More than 1024 ports selected. Use a shorter port list.",
    );
    expect(parsePorts("1-2000").error).toBe(
      "`1-2000` adds 2000 ports, taking the list past the 1024 port limit. Use a narrower range.",
    );
  });
});

describe("phaseLabel", () => {
  it("has a word for every phase the backend reports", () => {
    for (const phase of ["probing", "confirming", "resolving", "done", "cancelled"]) {
      expect(phaseLabel(phase)).not.toBe("");
    }
    expect(phaseLabel("probing")).toBe("Scanning");
    expect(phaseLabel("cancelled")).toBe("Stopped");
    // An unknown phase from a newer backend still reads sensibly.
    expect(phaseLabel("something-new")).toBe("Scanning");
  });
});

describe("formatCount", () => {
  it("groups thousands so a large scan stays readable", () => {
    expect(formatCount(1022)).toBe("1,022");
    expect(formatCount(65534)).toBe("65,534");
  });
});
