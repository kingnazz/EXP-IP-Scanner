import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSecurity } from "./useSecurity";
import { api } from "../lib/api";
import { sampleSecurityRun, securitySource } from "../test/security";
import type { ScanResult } from "../types";

afterEach(() => vi.restoreAllMocks());
it("assesses automatically and never starts Deep Scan implicitly", async () => {
  const data = await sampleSecurityRun();
  const assess = vi.spyOn(api, "assessSecurity").mockResolvedValue(data);
  const { result } = renderHook(() => useSecurity(securitySource));
  await waitFor(() => expect(result.current.devices).toHaveLength(1));
  expect(assess.mock.calls[0]?.[2]).toBe(false);
});
it("cancels prior work and discards its late events and completion", async () => {
  const data = await sampleSecurityRun();
  const resolvers: ((value: typeof data) => void)[] = [];
  const assess = vi
    .spyOn(api, "assessSecurity")
    .mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
  const cancel = vi.spyOn(api, "cancelSecurity").mockResolvedValue();
  const { result, rerender } = renderHook(
    ({ source }: { source: ScanResult | null }) => useSecurity(source),
    { initialProps: { source: securitySource as ScanResult | null } },
  );
  await waitFor(() => expect(assess).toHaveBeenCalledOnce());
  rerender({ source: null });
  expect(cancel).toHaveBeenCalled();
  await act(async () => {
    const call = assess.mock.calls[0]!;
    call[3]({
      scan_id: call[0].scan_id,
      assessment_id: call[1],
      devices: [data.devices[0]!],
    });
    resolvers[0]?.(data);
  });
  expect(result.current.devices).toHaveLength(0);
  expect(result.current.busy).toBe(false);
});
it("reports errors separately from discovery and allows retry", async () => {
  vi.spyOn(api, "assessSecurity").mockRejectedValue(
    new Error("Local TLS initialization failed"),
  );
  const { result } = renderHook(() => useSecurity(securitySource));
  await waitFor(() => expect(result.current.error).toContain("Local TLS"));
  expect(result.current.run?.cancelled).toBe(true);
  expect(securitySource.hosts).toHaveLength(1);
});

it("does not start new requests automatically after discovery was stopped", async () => {
  const assess = vi
    .spyOn(api, "assessSecurity")
    .mockResolvedValue(await sampleSecurityRun());
  const stoppedSource = { ...securitySource, cancelled: true };
  const { result } = renderHook(() => useSecurity(stoppedSource));
  expect(assess).not.toHaveBeenCalled();
  expect(result.current.busy).toBe(false);
  await act(async () => {
    await result.current.start();
  });
  expect(assess).toHaveBeenCalledOnce();
});
