import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Cable, Cloud, HardDrive, Server, Wifi } from "lucide-react";
import type { InterfaceKind, LocalNetwork } from "../types";
import { formatCount } from "../lib/format";

const KIND_ICON: Record<InterfaceKind, typeof Cable> = {
  ethernet: Cable,
  wireless: Wifi,
  vpn: Cloud,
  virtual: Server,
  other: HardDrive,
};

/**
 * Which adapter is being scanned, and the selector behind it.
 *
 * Just the adapter here: its address, its gateway and what is about to be swept
 * are one line below in the network summary, and printing them twice within
 * 30px would be noise. The selector only appears when there is more than one
 * viable interface, and it lists every one of them -- a technician sometimes
 * really does mean the VPN adapter or the Hyper-V switch, so those are ranked
 * lower but never hidden.
 */
export function InterfacePicker({
  networks,
  selected,
  onSelect,
  disabled = false,
}: {
  networks: LocalNetwork[];
  selected: LocalNetwork | null;
  onSelect: (network: LocalNetwork) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (networks.length === 0) {
    return (
      <div className="flex h-[var(--control-lg)] items-center gap-1.5 px-1 text-[12.5px] text-warn">
        <Cable size={14} aria-hidden />
        <span>No usable network adapter found</span>
      </div>
    );
  }

  const current = selected ?? networks[0];
  if (!current) return null;
  const Icon = KIND_ICON[current.kind];
  const only = networks.length === 1;

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        className={`flex h-[var(--control-lg)] max-w-[13rem] items-center gap-2 rounded-md px-2 text-left transition-colors ${
          only ? "cursor-default" : "hover:bg-surface-hover"
        }`}
        onClick={() => !only && setOpen((v) => !v)}
        disabled={disabled || only}
        aria-haspopup={only ? undefined : "listbox"}
        aria-expanded={only ? undefined : open}
        title={
          only
            ? `${current.interface} · ${current.ip} · /${current.prefix}`
            : "Choose which network adapter to scan"
        }
      >
        <Icon size={14} className="shrink-0 text-ink-muted" aria-hidden />
        <span className="min-w-0 truncate text-[12.5px] font-medium leading-tight">
          {shortName(current)}
        </span>
        {!only ? <ChevronDown size={13} className="shrink-0 text-ink-muted" aria-hidden /> : null}
      </button>

      {open ? (
        <div
          className="popover absolute left-0 top-[calc(100%+4px)] w-[22rem] p-1"
          role="listbox"
          aria-label="Network adapters"
        >
          {networks.map((network) => {
            const RowIcon = KIND_ICON[network.kind];
            const active = network.interface === current.interface && network.cidr === current.cidr;
            return (
              <button
                key={`${network.interface}-${network.cidr}`}
                type="button"
                role="option"
                aria-selected={active}
                className="menu-item h-auto items-start py-1.5"
                onClick={() => {
                  onSelect(network);
                  setOpen(false);
                }}
              >
                <RowIcon size={14} className="mt-0.5 shrink-0 text-ink-muted" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium">{network.interface}</span>
                    {network.recommended ? (
                      <span className="badge badge-accent">Best</span>
                    ) : null}
                    {network.kind === "virtual" || network.kind === "vpn" ? (
                      <span className="badge badge-neutral">{network.kind_label}</span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block truncate text-[11.5px] text-ink-muted">
                    <span className="mono">{network.ip}</span> · scans {network.suggested_cidr} ·{" "}
                    {formatCount(network.suggested_hosts)} addresses
                  </span>
                </span>
                {active ? (
                  <Check size={14} className="mt-0.5 shrink-0 text-accent-text" aria-hidden />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The adapter name, shortened for the one-line strip.
 *
 * A Windows adapter name can be `Intel(R) Wireless-AC 9560 160MHz`, which would
 * push the address off the end of the strip. The type word plus the trailing
 * number keeps `Ethernet 2` distinguishable from `Ethernet` without the noise.
 */
function shortName(network: LocalNetwork): string {
  const name = network.interface.trim();
  if (name.length <= 18) return name;
  const trailingNumber = name.match(/\b(\d+)\s*$/);
  return trailingNumber ? `${network.kind_label} ${trailingNumber[1]}` : network.kind_label;
}
