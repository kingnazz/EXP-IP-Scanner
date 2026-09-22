import { forwardRef, useEffect, useRef, useState } from "react";
import { ChevronDown, Play, Radio, RefreshCw, Square } from "lucide-react";
import type { LocalNetwork } from "../types";
import { InterfacePicker } from "./InterfacePicker";

/**
 * The scan bar: which network, what to scan, and the one button that matters.
 *
 * The Scan button is the visually dominant control in the window, because it
 * is the only thing a consultant has to do on a first run. It turns into Stop
 * while a scan is running rather than sitting next to a separate Stop, so
 * there is never a question about which one is live.
 */
export const ScanBar = forwardRef<
  HTMLInputElement,
  {
    networks: LocalNetwork[];
    selectedNetwork: LocalNetwork | null;
    onSelectNetwork: (network: LocalNetwork) => void;
    target: string;
    onTargetChange: (next: string) => void;
    targetError: string | null;
    recentTargets: string[];
    scanning: boolean;
    stopping: boolean;
    watching: boolean;
    watchIntervalMs: number;
    onWatchToggle: () => void;
    onWatchIntervalChange: (intervalMs: number) => void;
    onScan: () => void;
    onStop: () => void;
  }
>(function ScanBar(
  {
    networks,
    selectedNetwork,
    onSelectNetwork,
    target,
    onTargetChange,
    targetError,
    recentTargets,
    scanning,
    stopping,
    watching,
    watchIntervalMs,
    onWatchToggle,
    onWatchIntervalChange,
    onScan,
    onStop,
  },
  ref,
) {
  const [recentOpen, setRecentOpen] = useState(false);
  const recentBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!recentOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!recentBox.current?.contains(event.target as Node)) setRecentOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [recentOpen]);

  return (
    <div className="shrink-0 border-b border-line bg-surface px-3 py-2">
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (scanning) onStop();
          else onScan();
        }}
      >
        <InterfacePicker
          networks={networks}
          selected={selectedNetwork}
          onSelect={onSelectNetwork}
          disabled={scanning || watching}
        />

        <div className="divider-v my-1" />

        <div ref={recentBox} className="relative min-w-0 flex-1">
          <label className="sr-only" htmlFor="scan-target">
            Network to scan
          </label>
          <input
            ref={ref}
            id="scan-target"
            className={`field field-lg mono pr-9 ${targetError ? "field-invalid" : ""}`}
            value={target}
            onChange={(event) => onTargetChange(event.target.value)}
            placeholder="192.168.1.0/24, 192.168.1.1-254 or 10.0.0.50"
            spellCheck={false}
            autoComplete="off"
            disabled={scanning || watching}
            aria-invalid={targetError ? true : undefined}
            aria-describedby={targetError ? "scan-target-error" : undefined}
          />
          {recentTargets.length > 0 ? (
            <button
              type="button"
              className="icon-btn icon-btn-sm absolute right-1 top-1/2 -translate-y-1/2"
              onClick={() => setRecentOpen((v) => !v)}
              aria-label="Recent networks"
              title="Recent networks"
              aria-expanded={recentOpen}
              disabled={scanning || watching}
            >
              <ChevronDown size={14} />
            </button>
          ) : null}

          {recentOpen ? (
            <div className="popover absolute right-0 top-[calc(100%+4px)] z-50 w-[18rem] p-1">
              <p className="menu-label">Recent networks</p>
              {recentTargets.map((recent) => (
                <button
                  key={recent}
                  type="button"
                  className="menu-item mono text-[12.5px]"
                  onClick={() => {
                    onTargetChange(recent);
                    setRecentOpen(false);
                  }}
                >
                  {recent}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <button
          type="button"
          className="btn btn-lg btn-secondary min-w-[6.75rem]"
          style={
            watching
              ? {
                  background: "var(--accent-soft)",
                  borderColor: "var(--color-accent)",
                  color: "var(--color-ink)",
                }
              : undefined
          }
          disabled={!watching && (Boolean(targetError) || target.trim().length === 0 || scanning)}
          onClick={onWatchToggle}
          title={watching ? "Stop Watch Mode" : "Repeat scans and highlight network changes"}
          aria-pressed={watching}
        >
          <Radio size={13} className={watching ? "text-accent-text" : undefined} aria-hidden />
          {watching ? "Watching" : "Watch"}
        </button>

        <label className="sr-only" htmlFor="watch-interval">
          Watch interval
        </label>
        <select
          id="watch-interval"
          className="field field-lg w-[4.7rem] px-2 text-[12.5px]"
          value={watchIntervalMs}
          onChange={(event) => onWatchIntervalChange(Number(event.target.value))}
          title="Time between completed Watch Mode scans"
          aria-label="Watch interval"
        >
          <option value={5_000}>5s</option>
          <option value={10_000}>10s</option>
          <option value={30_000}>30s</option>
        </select>

        {scanning ? (
          <button
            type="submit"
            className="btn btn-lg btn-stop min-w-[7.5rem]"
            disabled={stopping}
            title={watching ? "Stop Watch Mode and the current scan (Escape)" : "Stop the scan (Escape)"}
          >
            <Square size={13} aria-hidden />
            {stopping ? "Stopping…" : "Stop"}
          </button>
        ) : (
          <button
            type="submit"
            className="btn btn-lg btn-primary min-w-[7.5rem]"
            disabled={Boolean(targetError) || target.trim().length === 0}
            title={watching ? "Run the next Watch scan now (F5)" : "Start the scan (F5)"}
          >
            {watching ? <RefreshCw size={13} aria-hidden /> : <Play size={13} aria-hidden />}
            {watching ? "Scan now" : "Scan"}
          </button>
        )}
      </form>

      {targetError ? (
        <p id="scan-target-error" role="alert" className="mt-1.5 text-[12px] text-danger">
          {targetError}
        </p>
      ) : null}
    </div>
  );
});
