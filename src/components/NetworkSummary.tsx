import { Globe, Loader2, RefreshCw } from "lucide-react";
import { formatCount } from "../lib/format";
import type { PublicIpState } from "../hooks/usePublicIp";
import type { LocalNetwork } from "../types";

/**
 * The network summary: where this machine is, in one line.
 *
 * Five facts a technician confirms before they scan and quotes afterwards --
 * the adapter, this machine's address, the gateway, what is about to be swept,
 * and how the site appears from outside. They sat in three different places
 * before this strip existed, and the public address was not available at all.
 *
 * One line, 28px, under the scan bar rather than in a panel of its own: it is
 * reference material, not a workflow, and the results table is what the window
 * is for. Every value can be clicked to copy it, because the next thing a
 * technician does with a gateway address is paste it somewhere.
 */
export function NetworkSummary({
  network,
  target,
  addressCount,
  publicIp,
  onRefreshPublicIp,
  onCopy,
}: {
  network: LocalNetwork | null;
  /** The target as typed, which is not always the adapter's own network. */
  target: string;
  addressCount: number | null;
  publicIp: PublicIpState;
  onRefreshPublicIp: () => void;
  onCopy: (value: string, what: string) => void;
}) {
  return (
    <div
      className="network-summary flex h-7 shrink-0 items-center gap-1.5 overflow-hidden border-b border-line bg-surface-raised px-3 text-[11.5px] text-ink-soft"
      aria-label="Network summary"
    >
      <Item label="Adapter" shrink>
        {network ? (
          <span className="truncate" title={network.interface}>
            {network.interface}
          </span>
        ) : (
          <Unknown>No adapter</Unknown>
        )}
      </Item>

      <Dot />
      <Item label="Local IP">
        {network ? (
          <Copyable value={network.ip} what="Local IP address" onCopy={onCopy} />
        ) : (
          <Unknown>—</Unknown>
        )}
      </Item>

      <Dot />
      <Item label="Gateway">
        {network?.gateway ? (
          <Copyable value={network.gateway} what="Gateway address" onCopy={onCopy} />
        ) : (
          // Not a failure. A second NIC or a Hyper-V switch has no default
          // route, and saying so is more use than an em dash.
          <Unknown title="No default route leaves by this adapter">None</Unknown>
        )}
      </Item>

      <Dot />
      <Item label="Scan range">
        {target ? (
          <>
            <span className="mono">{target}</span>
            {addressCount != null ? (
              <span className="summary-aside shrink-0 text-ink-muted">
                ({formatCount(addressCount)} {addressCount === 1 ? "address" : "addresses"})
              </span>
            ) : null}
          </>
        ) : (
          <Unknown>Not set</Unknown>
        )}
      </Item>

      <Dot />
      <div className="flex min-w-0 shrink-0 items-center gap-1.5">
        <Globe size={11} className="shrink-0 text-ink-muted" aria-hidden />
        <Item label="Public IP">
          <PublicIp state={publicIp} onCopy={onCopy} />
        </Item>
        {publicIp.status !== "off" ? (
          <button
            type="button"
            className="icon-btn icon-btn-sm size-[18px] rounded-sm"
            onClick={onRefreshPublicIp}
            disabled={publicIp.status === "loading"}
            title={
              publicIp.status === "ready"
                ? `Look up the public IP address again (asked ${publicIp.host})`
                : "Look up the public IP address again"
            }
            aria-label="Look up the public IP address again"
          >
            <RefreshCw size={10} aria-hidden />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function PublicIp({
  state,
  onCopy,
}: {
  state: PublicIpState;
  onCopy: (value: string, what: string) => void;
}) {
  switch (state.status) {
    case "loading":
      return (
        <span className="flex items-center gap-1 text-ink-muted">
          <Loader2 size={10} className="animate-spin" aria-hidden />
          Looking up…
        </span>
      );
    case "ready":
      return <Copyable value={state.ip} what="Public IP address" onCopy={onCopy} />;
    case "unavailable":
      // Offline, blocked by a firewall, or a captive portal in the way. All
      // three are ordinary on a customer site and none of them is an error
      // worth a toast.
      return <Unknown title="No lookup service could be reached">Unavailable</Unknown>;
    case "off":
      return <Unknown title="Turned off in Settings">Off</Unknown>;
  }
}

/**
 * A labelled fact. The label is quiet; the value is the thing being read.
 *
 * `shrink` marks the one item that may lose characters when the window is
 * narrow. Everything else holds its width, because half of an IP address is
 * not a smaller IP address.
 */
function Item({
  label,
  shrink = false,
  children,
}: {
  label: string;
  shrink?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className={`flex items-baseline gap-1 ${shrink ? "min-w-0" : "shrink-0"}`}>
      <span className="shrink-0 text-ink-muted">{label}</span>
      <span className="flex min-w-0 items-center gap-1 font-medium text-ink">{children}</span>
    </span>
  );
}

function Copyable({
  value,
  what,
  onCopy,
}: {
  value: string;
  what: string;
  onCopy: (value: string, what: string) => void;
}) {
  return (
    <button
      type="button"
      className="mono truncate rounded-sm underline-offset-2 hover:underline"
      onClick={() => onCopy(value, what)}
      title={`${value} — click to copy`}
    >
      {value}
    </button>
  );
}

function Unknown({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span className="font-normal text-ink-muted" title={title}>
      {children}
    </span>
  );
}

function Dot() {
  return (
    <span className="shrink-0 text-ink-muted" aria-hidden>
      ·
    </span>
  );
}
