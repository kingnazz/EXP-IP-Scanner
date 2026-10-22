import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import { api } from "./lib/api";
import { demoAssessment } from "./lib/security-demo";
import { ETHERNET, NAS, WINDOWS_SERVER } from "./test/devices";
import { securitySource } from "./test/security";
import type { ScanResult } from "./types";

beforeEach(() => {
  localStorage.setItem(
    "exp-ip-scanner-settings",
    JSON.stringify({
      theme: "light",
      lookupPublicIp: false,
      portSpec: "22,9001",
      scanServices: false,
    }),
  );
  vi.spyOn(api, "runtimeInfo").mockResolvedValue({
    version: "1.3.0",
    edition: "portable",
    edition_label: "Portable",
    platform: "Windows",
    architecture: "x64",
    update_mode: "manual",
  });
  vi.spyOn(api, "detectNetworks").mockResolvedValue([ETHERNET]);
  vi.spyOn(api, "serviceCatalog").mockResolvedValue([]);
  vi.spyOn(api, "defaultPorts").mockResolvedValue([22, 80, 443, 445, 3389]);
  vi.spyOn(api, "previewScan").mockResolvedValue({
    total: 254,
    port_count: 5,
    workload: 1270,
    warning: null,
  });
  vi.spyOn(api, "cancelSecurity").mockResolvedValue();
  vi.spyOn(api, "assessSecurity").mockImplementation(demoAssessment);
});

async function exposureButton() {
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Network to scan") as HTMLInputElement).value,
    ).toBe(ETHERNET.suggested_cidr),
  );
  return screen.getByRole("button", { name: "Scan Web Exposure" });
}

it("discovers the entire target with web services enabled, then assesses every discovered device", async () => {
  const scan = vi
    .spyOn(api, "scan")
    .mockImplementation(async (options, listeners = {}) => {
      listeners.onStarted?.({
        scan_id: 42,
        target: options.target,
        total: 254,
        port_count: options.ports.length,
        warning: null,
      });
      return {
        ...securitySource,
        target: options.target,
        ports: options.ports,
        hosts: [NAS, WINDOWS_SERVER],
      };
    });
  render(<App />);
  fireEvent.click(await exposureButton());
  await waitFor(() => expect(api.assessSecurity).toHaveBeenCalledOnce());
  const options = scan.mock.calls[0]![0];
  expect(options.target).toBe(ETHERNET.suggested_cidr);
  expect(options.scan_services).toBe(true);
  expect(options.ports).toEqual([
    22, 80, 443, 5000, 5001, 8000, 8080, 8443, 8888, 9001,
  ]);
  expect(vi.mocked(api.assessSecurity).mock.calls[0]![0].hosts).toEqual([
    NAS,
    WINDOWS_SERVER,
  ]);
  expect(vi.mocked(api.assessSecurity).mock.calls[0]![2]).toBe(false);
  expect(
    screen.getByRole("region", { name: "Security assessment" }),
  ).toBeTruthy();
  const saved = JSON.parse(localStorage.getItem("exp-ip-scanner-settings")!);
  expect(saved.scanServices).toBe(false);
  expect(saved.portSpec).toBe("22,9001");
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Scan Web Exposure" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.change(screen.getByLabelText("Find a device or technology"), {
    target: { value: "no-matching-device" },
  });
  expect(
    screen.queryByRole("button", { name: /View security details for/ }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Scan Web Exposure" }));
  await waitFor(() => expect(api.assessSecurity).toHaveBeenCalledTimes(2));
  expect(
    (screen.getByLabelText("Find a device or technology") as HTMLInputElement)
      .value,
  ).toBe("");
  expect(vi.mocked(api.assessSecurity).mock.calls[1]![0].hosts).toEqual([
    NAS,
    WINDOWS_SERVER,
  ]);
});

it("can stop during discovery without starting security requests or overlapping scans", async () => {
  let finish: ((result: ScanResult) => void) | undefined;
  vi.spyOn(api, "scan").mockImplementation((options, listeners = {}) => {
    listeners.onStarted?.({
      scan_id: 42,
      target: options.target,
      total: 254,
      port_count: options.ports.length,
      warning: null,
    });
    listeners.onProgress?.({
      scan_id: 42,
      done: 10,
      total: 254,
      found: 1,
      phase: "probing",
      elapsed_ms: 100,
    });
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const cancel = vi.spyOn(api, "cancelScan").mockImplementation(async () => {
    finish?.({ ...securitySource, cancelled: true });
  });
  render(<App />);
  fireEvent.click(await exposureButton());
  expect(
    screen
      .getByRole("button", { name: "Scan Web Exposure" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.getByText(/Discovering services: 10 \/ 254/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Stop discovery" }));
  await waitFor(() =>
    expect(
      screen.getByText(/Discovery stopped\. Start Safe Scan/),
    ).toBeTruthy(),
  );
  expect(cancel).toHaveBeenCalledOnce();
  expect(api.assessSecurity).not.toHaveBeenCalled();
});

it("keeps the normal Scan action and Watch Mode separate from web exposure", async () => {
  vi.spyOn(api, "scan").mockResolvedValue({ ...securitySource, hosts: [] });
  render(<App />);
  await exposureButton();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^Scan$/ }));
  });
  expect(vi.mocked(api.scan).mock.calls[0]![0].ports).toEqual([22, 9001]);
  expect(vi.mocked(api.scan).mock.calls[0]![0].scan_services).toBe(false);
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Scan Web Exposure" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: /^Watch$/ }));
  expect(
    screen
      .getByRole("button", { name: "Scan Web Exposure" })
      .hasAttribute("disabled"),
  ).toBe(true);
});
