import { forwardRef, useEffect, useRef, useState } from "react";
import { Check, Columns3, Copy, Download, Info, List, Search, Trash2, X } from "lucide-react";
import { FILTER_MODES, TOGGLEABLE_COLUMNS, type ColumnKey, type FilterMode } from "../lib/table";
import { formatCount } from "../lib/format";

/**
 * Search, filters and the two output actions.
 *
 * Search sits first and widest because it is the thing used most: on a busy
 * network, finding the device is the task. Filters are three buttons rather
 * than a builder -- "All", "Responding", "Has services" covers what a
 * consultant actually asks of a scan.
 */
export const ResultsToolbar = forwardRef<
  HTMLInputElement,
  {
    query: string;
    onQueryChange: (next: string) => void;
    filter: FilterMode;
    onFilterChange: (next: FilterMode) => void;
    counts: Record<FilterMode, number>;
    selectedCount: number;
    rowCount: number;
    hiddenColumns: ColumnKey[];
    onToggleColumn: (key: ColumnKey) => void;
    onResetColumns: () => void;
    onExport: () => void;
    onCopy: () => void;
    onCopyIps: () => void;
    onClear: () => void;
  }
>(function ResultsToolbar(
  {
    query,
    onQueryChange,
    filter,
    onFilterChange,
    counts,
    selectedCount,
    rowCount,
    hiddenColumns,
    onToggleColumn,
    onResetColumns,
    onExport,
    onCopy,
    onCopyIps,
    onClear,
  },
  ref,
) {
  const [columnsOpen, setColumnsOpen] = useState(false);
  const columnsBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!columnsOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!columnsBox.current?.contains(event.target as Node)) setColumnsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setColumnsOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [columnsOpen]);

  const hasRows = rowCount > 0;
  const copyLabel =
    selectedCount > 0
      ? `Copy ${formatCount(selectedCount)} selected ${selectedCount === 1 ? "row" : "rows"}`
      : "Copy every row shown, tab separated for pasting into a ticket or spreadsheet";

  return (
    <div className="results-toolbar flex h-9 shrink-0 items-center gap-2 border-b border-line bg-surface-raised px-3">
      <div className="relative min-w-[8rem] w-full max-w-[22rem] shrink">
        <Search
          size={13}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted"
          aria-hidden
        />
        <label className="sr-only" htmlFor="results-search">
          Search results
        </label>
        <input
          ref={ref}
          id="results-search"
          className="field h-[var(--control-sm)] pl-7 pr-7 text-[12.5px]"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search address, name, MAC or service"
          spellCheck={false}
          autoComplete="off"
          type="text"
          role="searchbox"
        />
        {query ? (
          <button
            type="button"
            className="icon-btn icon-btn-sm absolute right-0.5 top-1/2 -translate-y-1/2"
            onClick={() => onQueryChange("")}
            aria-label="Clear search"
            title="Clear search"
          >
            <X size={12} />
          </button>
        ) : null}
      </div>

      <div className="segmented shrink-0" role="group" aria-label="Filter results">
        {FILTER_MODES.map((mode) => (
          <button
            key={mode.id}
            type="button"
            className="segmented-item whitespace-nowrap"
            aria-pressed={filter === mode.id}
            onClick={() => onFilterChange(mode.id)}
            title={mode.hint}
          >
            {mode.label}
            <span className="count-badge">{formatCount(counts[mode.id])}</span>
          </button>
        ))}
      </div>

      <span
        className="results-interaction-hint shrink-0 items-center gap-1.5 text-[11px] text-ink-muted"
        title="Double-click a device to open its details. Right-click for quick actions."
      >
        <Info size={12} aria-hidden />
        Double-click for details · Right-click for actions
      </span>

      <div className="flex-1" />

      <div ref={columnsBox} className="relative shrink-0">
        <button
          type="button"
          className="btn btn-sm btn-secondary shrink-0"
          onClick={() => setColumnsOpen((v) => !v)}
          aria-expanded={columnsOpen}
          title="Choose which columns to show"
        >
          <Columns3 size={13} aria-hidden />
          <span className="toolbar-text">Columns</span>
        </button>
        {columnsOpen ? (
          <div className="popover absolute right-0 top-[calc(100%+4px)] w-[15rem] p-1">
            <p className="menu-label">Columns</p>
            {TOGGLEABLE_COLUMNS.map((column) => {
              const shown = !hiddenColumns.includes(column.key);
              return (
                <button
                  key={column.key}
                  type="button"
                  className="menu-item"
                  onClick={() => onToggleColumn(column.key)}
                  role="menuitemcheckbox"
                  aria-checked={shown}
                >
                  <Check
                    size={13}
                    className={shown ? "text-accent-text" : "opacity-0"}
                    aria-hidden
                  />
                  <span className="flex-1">{column.label}</span>
                </button>
              );
            })}
            <div className="my-1 h-px bg-line" />
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                onResetColumns();
                setColumnsOpen(false);
              }}
            >
              <span className="w-[13px]" />
              <span className="flex-1">Reset column widths</span>
            </button>
          </div>
        ) : null}
      </div>

      <button
        type="button"
        className="btn btn-sm btn-secondary shrink-0"
        onClick={onCopy}
        disabled={!hasRows}
        title={copyLabel}
      >
        <Copy size={13} aria-hidden />
        <span className="toolbar-text">
          {selectedCount > 0 ? `Copy ${formatCount(selectedCount)}` : "Copy"}
        </span>
      </button>

      <button
        type="button"
        className="btn btn-sm btn-secondary shrink-0"
        onClick={onCopyIps}
        disabled={!hasRows}
        title={
          selectedCount > 0
            ? `Copy IP addresses for ${formatCount(selectedCount)} selected ${selectedCount === 1 ? "device" : "devices"}`
            : "Copy IP addresses for every row shown, one per line"
        }
      >
        <List size={13} aria-hidden />
        <span className="toolbar-text">Copy IPs</span>
      </button>

      <button
        type="button"
        className="btn btn-sm btn-secondary shrink-0"
        onClick={onExport}
        disabled={!hasRows}
        title="Export the rows shown as a CSV spreadsheet (Ctrl+E)"
      >
        <Download size={13} aria-hidden />
        <span className="toolbar-text">Export CSV</span>
      </button>

      <button
        type="button"
        className="icon-btn icon-btn-sm shrink-0"
        onClick={onClear}
        disabled={!hasRows}
        title="Clear the results"
        aria-label="Clear the results"
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
});
