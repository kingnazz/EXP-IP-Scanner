import { useEffect, useRef } from "react";
import { Loader2, X } from "lucide-react";
import { deviceActions, primaryAction, type DeviceAction } from "../lib/actions";
import { formatLatency, formatTime, isActionablePort, serviceName } from "../lib/format";
import type { DeviceRow } from "../lib/live";
import type { LocalNetwork, PingOutcome } from "../types";
import { DetailRow, NoValue, SectionTitle } from "../ui/primitives";

/**
 * The device details panel.
 *
 * A drawer over the right-hand side rather than a page, because leaving the
 * results to look at one device would lose the consultant's place in a scan
 * that may still be running. The scan keeps going and the table keeps
 * updating behind it.
 */
export function DeviceDrawer({
  row,
  network,
  onClose,
  onAction,
  pingResult,
  pinging,
}: {
  row: DeviceRow;
  /** The interface the scan ran from, for the network context section. */
  network: LocalNetwork | null;
  onClose: () => void;
  onAction: (action: DeviceAction) => void;
  pingResult: PingOutcome | null;
  pinging: boolean;
}) {
  const panel = useRef<HTMLElement>(null);
  const { host } = row;
  const actions = deviceActions(host);
  const primary = primaryAction(host);
  const connect = actions.filter((a) => a.group === "connect");
  const diagnostics = actions.filter((a) => a.group === "diagnostics");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <aside
      ref={panel}
      className="animate-slide-in-right flex w-[21rem] shrink-0 flex-col border-l border-line bg-surface-raised"
      aria-label={`Details for ${host.ip}`}
    >
      <header className="flex items-start gap-2 border-b border-line px-3.5 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[13.5px] font-semibold leading-tight">
            {host.hostname?.trim() || host.ip}
          </h2>
          <p className="mono mt-0.5 truncate text-[12px] text-ink-muted">{host.ip}</p>
        </div>
        {host.is_self ? <span className="badge badge-accent mt-0.5">This PC</span> : null}
        <button type="button" className="icon-btn icon-btn-sm -mr-1" onClick={onClose} aria-label="Close details">
          <X size={14} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        {primary ? (
          <button
            type="button"
            className="btn btn-primary mb-3 w-full"
            onClick={() => onAction(primary)}
            title={primary.hint}
          >
            {primary.label}
          </button>
        ) : null}

        <dl className="mb-4">
          <DetailRow label="IP address" mono>
            {host.ip}
          </DetailRow>
          <DetailRow label="Hostname">
            {host.hostname?.trim() ?? <NoValue title="No reverse DNS record for this address" />}
          </DetailRow>
          <DetailRow label="MAC address" mono>
            {host.mac?.trim() ?? (
              <NoValue title="Only visible for devices on your own network segment" />
            )}
          </DetailRow>
          <DetailRow label="Manufacturer">
            {host.vendor?.trim() ?? <NoValue title="No manufacturer registered for this MAC prefix" />}
          </DetailRow>
          <DetailRow label="Latency">
            {formatLatency(host.latency_ms) ?? (
              <NoValue title="This device answered no ping and no TCP probe" />
            )}
          </DetailRow>
          {host.icmp_ms != null || host.tcp_ms != null ? (
            <DetailRow label="Measured">
              <span className="text-[12px] text-ink-soft">
                {host.icmp_ms != null ? `ping ${formatLatency(host.icmp_ms)}` : null}
                {host.icmp_ms != null && host.tcp_ms != null ? " · " : null}
                {host.tcp_ms != null ? `TCP ${formatLatency(host.tcp_ms)}` : null}
              </span>
            </DetailRow>
          ) : null}
          <DetailRow label="TTL">
            {host.ttl != null ? host.ttl : <NoValue title="No ICMP reply to read a TTL from" />}
          </DetailRow>
          <DetailRow label="Device type">
            {host.os_hint ? (
              <span>
                {host.os_hint}{" "}
                <span
                  className="text-[11.5px] text-ink-muted"
                  title="Derived from the reply TTL. A hint, not a reliable identification."
                >
                  (estimated)
                </span>
              </span>
            ) : (
              <NoValue title="Not enough information to estimate" />
            )}
          </DetailRow>
          <DetailRow label="Found at">{formatTime(host.seen_at)}</DetailRow>
        </dl>

        <section className="mb-4">
          <SectionTitle>Open ports</SectionTitle>
          {host.open_ports.length === 0 ? (
            <p className="text-[12.5px] text-ink-muted">
              No open ports among the ports scanned. This device was found on the network but
              answered nothing, which is normal for printers, cameras and hardened workstations.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {host.open_ports.map((port) => (
                <li
                  key={port}
                  className="flex items-baseline gap-2 rounded-sm px-1.5 py-1"
                  style={
                    isActionablePort(port) ? { background: "var(--accent-soft)" } : undefined
                  }
                >
                  <span className="mono w-11 shrink-0 text-[12px] font-semibold">{port}</span>
                  <span className="text-[12.5px]">
                    {serviceName(port) ?? (
                      <span className="text-ink-muted">Unrecognised service</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mb-4">
          <SectionTitle>Connect</SectionTitle>
          <div className="grid grid-cols-2 gap-1.5">
            {connect.map((action) => (
              <button
                key={action.id}
                type="button"
                className="btn btn-sm btn-secondary justify-start"
                disabled={!action.available}
                title={action.hint}
                onClick={() => onAction(action)}
              >
                <span className="truncate">{shortLabel(action.label)}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="mb-4">
          <SectionTitle>Diagnose</SectionTitle>
          <div className="flex flex-wrap gap-1.5">
            {diagnostics.map((action) => (
              <button
                key={action.id}
                type="button"
                className="btn btn-sm btn-secondary"
                title={action.hint}
                onClick={() => onAction(action)}
              >
                {action.id === "ping" && pinging ? (
                  <Loader2 size={12} className="animate-spin" aria-hidden />
                ) : null}
                {shortLabel(action.label)}
              </button>
            ))}
          </div>
          {pingResult ? (
            <p
              className={`mono mt-2 rounded-sm px-2 py-1.5 text-[11.5px] leading-snug ${
                pingResult.replied ? "text-ok" : "text-warn"
              }`}
              style={{ background: "var(--color-surface-sunken)" }}
              role="status"
            >
              {pingResult.summary}
            </p>
          ) : null}
        </section>

        <section>
          <SectionTitle>Network</SectionTitle>
          {network ? (
            <p className="text-[12.5px] leading-relaxed text-ink-soft">
              Scanned from <span className="font-medium text-ink">{network.interface}</span> at{" "}
              <span className="mono">{network.ip}</span>
              <span className="text-ink-muted"> /{network.prefix}</span>
              <br />
              <span className="text-ink-muted">
                {network.kind_label} adapter · {network.cidr}
              </span>
            </p>
          ) : (
            <p className="text-[12.5px] text-ink-muted">No adapter information available.</p>
          )}
        </section>
      </div>
    </aside>
  );
}

/** Button labels in the drawer drop the leading verb, which the heading says. */
function shortLabel(label: string): string {
  return label.replace(/^Open /, "").replace(/^Copy /, "Copy ");
}
