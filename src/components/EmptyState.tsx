import { Play, SearchX, Wifi } from "lucide-react";
import { formatCount } from "../lib/format";

/**
 * What fills the results area before a scan, and when a search matches
 * nothing.
 *
 * Compact and centred rather than a giant empty grid with column headings over
 * nothing. It states what is about to be scanned and how many addresses that
 * is, so the first thing a consultant reads confirms the tool got the network
 * right -- and then gives them the button.
 */
export function ReadyState({
  target,
  addressCount,
  warning,
  disabled,
  onScan,
}: {
  target: string;
  addressCount: number | null;
  warning: string | null;
  disabled: boolean;
  onScan: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 bg-surface px-6 py-10">
      <div
        className="flex size-11 items-center justify-center rounded-lg"
        style={{ background: "var(--accent-soft)" }}
      >
        <Wifi size={20} className="text-accent-text" aria-hidden />
      </div>

      <div className="max-w-md text-center">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em]">
          Ready to scan <span className="mono text-[14.5px]">{target || "a network"}</span>
        </h2>
        <p className="mt-1 text-[12.5px] text-ink-muted">
          {addressCount != null
            ? `${formatCount(addressCount)} ${addressCount === 1 ? "address" : "addresses"}`
            : "Enter a network above to get started"}
        </p>
      </div>

      <button
        type="button"
        className="btn btn-lg btn-primary"
        onClick={onScan}
        disabled={disabled}
      >
        <Play size={13} aria-hidden />
        Scan network
      </button>

      {warning ? (
        <p className="max-w-md text-center text-[12px] leading-snug text-warn">{warning}</p>
      ) : null}

      <p className="max-w-md text-center text-[11.5px] leading-relaxed text-ink-muted">
        Devices appear as they are found. Double-click one for its details, or right-click for
        Remote Desktop, file shares, SSH and its web interface.
      </p>
    </div>
  );
}

/** Shown when a scan found devices but the search or filter hides all of them. */
export function NoMatchesState({
  query,
  onClearSearch,
}: {
  query: string;
  onClearSearch: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-surface px-6 py-10">
      <SearchX size={20} className="text-ink-muted" aria-hidden />
      <div className="max-w-sm text-center">
        <h2 className="text-[14px] font-semibold">No devices match</h2>
        <p className="mt-1 text-[12.5px] text-ink-muted">
          {query ? (
            <>
              Nothing found for <span className="mono">{query}</span> with the current filter.
            </>
          ) : (
            "Nothing found with the current filter."
          )}
        </p>
      </div>
      {query ? (
        <button type="button" className="btn btn-sm btn-secondary" onClick={onClearSearch}>
          Clear search
        </button>
      ) : null}
    </div>
  );
}
