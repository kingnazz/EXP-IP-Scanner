import { CheckCircle2, CircleSlash, Loader2 } from "lucide-react";
import { formatCount, formatDuration, phaseLabel } from "../lib/format";
import type { ScanProgress, ScanStarted } from "../types";
import type { ScanSummary } from "../hooks/useScan";

/**
 * Live scan status, and the completion line afterwards.
 *
 * One strip, 26px tall, that never moves and never interrupts. There is no
 * completion dialog on purpose: a consultant who has just watched a table fill
 * does not need to be told it finished and then click to continue.
 */
export function ProgressStrip({
  scanning,
  stopping,
  progress,
  started,
  summary,
  shownCount,
  totalCount,
}: {
  scanning: boolean;
  stopping: boolean;
  progress: ScanProgress | null;
  started: ScanStarted | null;
  summary: ScanSummary | null;
  /** Rows currently passing the search and filter. */
  shownCount: number;
  /** Rows found in total, before filtering. */
  totalCount: number;
}) {
  const total = progress?.total ?? started?.total ?? 0;
  const done = progress?.done ?? 0;
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const filtered = shownCount !== totalCount;

  return (
    <div className="shrink-0 border-t border-line bg-surface">
      <div className="progress-track">
        {scanning ? (
          percent > 0 ? (
            <div className="progress-fill" style={{ width: `${percent}%` }} />
          ) : (
            <div className="progress-indeterminate absolute inset-0" />
          )
        ) : null}
      </div>

      <div className="flex h-[26px] items-center gap-2 px-3 text-[11.5px] text-ink-soft">
        {scanning ? (
          <>
            <Loader2 size={12} className="shrink-0 animate-spin text-accent-text" aria-hidden />
            <span className="font-medium text-ink">
              {stopping ? "Stopping…" : phaseLabel(progress?.phase ?? "probing")}
            </span>
            {total > 0 ? (
              <>
                <Dot />
                <span className="mono">
                  {formatCount(done)} / {formatCount(total)} addresses
                </span>
              </>
            ) : null}
            <Dot />
            <span>
              <span className="mono">{formatCount(progress?.found ?? totalCount)}</span> found
            </span>
            {progress ? (
              <>
                <Dot />
                <span className="mono">{formatDuration(progress.elapsed_ms)}</span>
              </>
            ) : null}
          </>
        ) : summary ? (
          <>
            {summary.cancelled ? (
              <CircleSlash size={12} className="shrink-0 text-warn" aria-hidden />
            ) : (
              <CheckCircle2 size={12} className="shrink-0 text-ok" aria-hidden />
            )}
            <span className="font-medium text-ink">
              {formatCount(summary.found)} {summary.found === 1 ? "device" : "devices"} found
            </span>
            <Dot />
            <span>
              <span className="mono">
                {formatCount(summary.cancelled ? summary.probed : summary.scanned)}
              </span>{" "}
              of <span className="mono">{formatCount(summary.scanned)}</span> addresses scanned
            </span>
            <Dot />
            <span className="mono">{formatDuration(summary.durationMs)}</span>
            {summary.cancelled ? (
              <>
                <Dot />
                <span className="text-warn">Stopped early</span>
              </>
            ) : null}
          </>
        ) : (
          <span className="text-ink-muted">Ready</span>
        )}

        <div className="flex-1" />

        {filtered ? (
          <span className="shrink-0 text-ink-muted">
            Showing <span className="mono">{formatCount(shownCount)}</span> of{" "}
            <span className="mono">{formatCount(totalCount)}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Dot() {
  return (
    <span className="shrink-0 text-ink-muted" aria-hidden>
      ·
    </span>
  );
}
