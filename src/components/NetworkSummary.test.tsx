import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ETHERNET } from "../test/devices";
import { NetworkSummary } from "./NetworkSummary";

describe("network summary copy", () => {
  it("copies the whole network context as one ticket-ready block", () => {
    const onCopy = vi.fn();
    render(
      <NetworkSummary
        network={ETHERNET}
        target="192.168.50.0/24"
        addressCount={254}
        publicIp={{ status: "ready", ip: "203.0.113.44", host: "api.ipify.org" }}
        onRefreshPublicIp={vi.fn()}
        onCopy={onCopy}
      />,
    );

    screen.getByRole("button", { name: "Network details to clipboard" }).click();

    expect(onCopy).toHaveBeenCalledWith(
      [
        "Adapter      Ethernet",
        "Local IP     192.168.50.37",
        "Gateway      192.168.50.1",
        "Scan range   192.168.50.0/24 (254 addresses)",
        "Public IP    203.0.113.44",
      ].join("\n"),
      "Network summary",
    );
  });

  it("copies an explicit Off state when public IP lookup is disabled", () => {
    const onCopy = vi.fn();
    render(
      <NetworkSummary
        network={ETHERNET}
        target={ETHERNET.cidr}
        addressCount={254}
        publicIp={{ status: "off" }}
        onRefreshPublicIp={vi.fn()}
        onCopy={onCopy}
      />,
    );

    screen.getByRole("button", { name: "Network details to clipboard" }).click();
    expect(onCopy.mock.calls[0]?.[0]).toContain("Public IP    Off");
  });
});
