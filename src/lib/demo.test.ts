import { beforeAll, describe, expect, it } from "vitest";
import { demo, setDemoScanDuration } from "./demo";
import type { HostEvent, HostRemovedEvent, ScanOptions, ScanProgress, ScanStarted } from "../types";

const OPTIONS: ScanOptions = {
  target: "192.168.50.0/24",
  ports: [],
  timeout_ms: 900,
  concurrency: 64,
  tcp_concurrency: 256,
  ping_concurrency: 32,
  resolve_hostnames: true,
  scan_services: true,
};

beforeAll(() => {
  // These tests assert on the sequence of events, not on how long they take to
  // arrive, so the simulated sweep runs at speed.
  setDemoScanDuration(300);
});

function collector() {
  const started: ScanStarted[] = [];
  const progress: ScanProgress[] = [];
  const discovered: HostEvent[] = [];
  const updated: HostEvent[] = [];
  const removed: HostRemovedEvent[] = [];
  return {
    started,
    progress,
    discovered,
    updated,
    removed,
    listeners: {
      onStarted: (e: ScanStarted) => started.push(e),
      onProgress: (e: ScanProgress) => progress.push(e),
      onHostDiscovered: (e: HostEvent) => discovered.push(e),
      onHostUpdated: (e: HostEvent) => updated.push(e),
      onHostRemoved: (e: HostRemovedEvent) => removed.push(e),
    },
  };
}

describe("the demo network", () => {
  it("reports the interfaces a consultant's laptop plausibly has, best first", () => {
    const networks = demo.detectNetworks();
    expect(networks[0]?.interface).toBe("Ethernet");
    expect(networks[0]?.recommended).toBe(true);
    expect(networks.filter((n) => n.recommended)).toHaveLength(1);
    // The awkward ones are present but not the default, which is the whole
    // point of the adapter ranking.
    expect(networks.map((n) => n.kind)).toContain("vpn");
    expect(networks.map((n) => n.kind)).toContain("virtual");
  });

  it("sizes a scan the way the backend would", () => {
    expect(demo.previewScan(OPTIONS).total).toBe(254);
    expect(demo.previewScan({ ...OPTIONS, target: "192.168.50.1-20" }).total).toBe(20);
    expect(demo.previewScan({ ...OPTIONS, target: "192.168.50.10" }).total).toBe(1);
    expect(demo.previewScan({ ...OPTIONS, target: "10.4.0.0/22" }).total).toBe(1022);
  });

  it("refuses a target that is not a network", () => {
    expect(() => demo.previewScan({ ...OPTIONS, target: "nonsense" })).toThrow();
    expect(() => demo.previewScan({ ...OPTIONS, target: "" })).toThrow();
  });

  it("names every port the default set probes", () => {
    const catalog = new Map(demo.serviceCatalog().map((s) => [s.port, s.name]));
    for (const port of demo.defaultPorts()) {
      expect(catalog.get(port), `port ${port}`).toBeDefined();
    }
  });
});

describe("a demo scan", () => {
  it("streams devices, then enriches them, then finishes", async () => {
    const c = collector();
    const result = await demo.scan(OPTIONS, c.listeners);

    expect(c.started).toHaveLength(1);
    expect(c.started[0]?.total).toBe(254);
    expect(c.discovered.length).toBeGreaterThan(10);
    expect(c.removed).toHaveLength(0);

    // A device is discovered before it is named, which is the sequence the
    // table's field-by-field merge exists to handle.
    const first = c.discovered[0];
    expect(first?.host.mac).toBeNull();
    expect(first?.host.vendor).toBeNull();

    // Every device gets exactly one final update.
    const finals = c.updated.filter((e) => e.is_final);
    expect(finals).toHaveLength(result.hosts.length);
    expect(finals.every((e) => e.host.mac != null)).toBe(true);

    // And some hostnames arrive mid-scan, not marked final.
    expect(c.updated.some((e) => e.is_final === false && e.host.hostname != null)).toBe(true);

    expect(result.cancelled).toBe(false);
    expect(result.scanned).toBe(254);
    expect(result.probed).toBe(254);
    expect(c.progress.at(-1)?.phase).toBe("done");
  });

  it("finds the devices that make the awkward cases real", async () => {
    const result = await demo.scan(OPTIONS);
    const byIp = new Map(result.hosts.map((h) => [h.ip, h]));

    // A domain controller with a full Windows service set.
    expect(byIp.get("192.168.50.10")?.open_ports).toContain(3389);
    // A printer found only through ARP: no latency, no open ports, but a MAC.
    const quiet = byIp.get("192.168.50.26");
    expect(quiet?.latency_ms).toBeNull();
    expect(quiet?.open_ports).toEqual([]);
    expect(quiet?.mac).not.toBeNull();
    // This machine is marked.
    expect(result.hosts.filter((h) => h.is_self)).toHaveLength(1);
  });

  it("scales its device list to the target", async () => {
    const small = await demo.scan({ ...OPTIONS, target: "192.168.50.1-20" });
    expect(small.scanned).toBe(20);
    expect(small.hosts.every((h) => Number(h.ip.split(".")[3]) <= 20)).toBe(true);

    const single = await demo.scan({ ...OPTIONS, target: "192.168.50.10" });
    expect(single.scanned).toBe(1);
    expect(single.hosts.map((h) => h.ip)).toEqual(["192.168.50.10"]);
  });

  it("places its devices in whatever subnet it was pointed at", async () => {
    const result = await demo.scan({ ...OPTIONS, target: "10.20.30.0/24" });
    expect(result.hosts.every((h) => h.ip.startsWith("10.20.30."))).toBe(true);
  });

  it("only reports services from the ports it was asked to probe", async () => {
    const result = await demo.scan({ ...OPTIONS, ports: [3389] });
    expect(result.ports).toEqual([3389]);
    expect(result.hosts.every((h) => h.open_ports.every((p) => p === 3389))).toBe(true);
  });

  it("stops promptly and reports itself cancelled", async () => {
    const c = collector();
    const running = demo.scan(OPTIONS, c.listeners);
    // Stop once the first devices are in, the way a consultant would.
    await new Promise((resolve) => setTimeout(resolve, 60));
    demo.cancelScan();
    const result = await running;

    expect(result.cancelled).toBe(true);
    expect(result.probed).toBeLessThan(result.scanned);
    // A stopped scan keeps what it already found.
    expect(result.hosts.length).toBeGreaterThan(0);
    // Fewer than the whole network: a stopped scan reports what it reached.
    expect(result.hosts.length).toBeLessThan(26);
    // And every device it reports, it actually streamed first.
    expect(result.hosts.length).toBe(c.discovered.length);
    expect(c.progress.at(-1)?.phase).toBe("cancelled");
  });

  it("refuses a target it cannot parse instead of returning nothing", async () => {
    await expect(demo.scan({ ...OPTIONS, target: "nope" })).rejects.toThrow();
  });
});

describe("the demo ping", () => {
  it("answers for a device that responds, and says so for one that does not", async () => {
    const replied = await demo.ping("192.168.50.10");
    expect(replied.replied).toBe(true);
    expect(replied.rtt_ms).toBeGreaterThan(0);
    expect(replied.summary).toContain("Reply from 192.168.50.10");

    // The ARP-only printer.
    const quiet = await demo.ping("192.168.50.26");
    expect(quiet.replied).toBe(false);
    expect(quiet.summary).toContain("No reply");
  });
});

describe("the demo port parser", () => {
  it("accepts what the backend accepts", () => {
    expect(demo.parsePortSpec("22,80,443")).toEqual([22, 80, 443]);
    expect(demo.parsePortSpec("80-82")).toEqual([80, 81, 82]);
    expect(demo.parsePortSpec("")).toEqual(demo.defaultPorts());
  });

  it("refuses what the backend refuses", () => {
    expect(() => demo.parsePortSpec("http")).toThrow();
    expect(() => demo.parsePortSpec("0")).toThrow();
    expect(() => demo.parsePortSpec("70000")).toThrow();
  });
});
