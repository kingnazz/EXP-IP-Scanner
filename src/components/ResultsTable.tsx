import { memo, useCallback, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, CirclePlus, CircleSlash, RefreshCw } from "lucide-react";
import { useVirtualRows } from "../hooks/useVirtualRows";
import { formatLatency, isActionablePort, serviceName } from "../lib/format";
import { isResponding, rowName, type DeviceRow } from "../lib/live";
import { COLUMNS, type ColumnDef, type ColumnKey, type SortDir } from "../lib/table";
import type { ColumnWidths, Density } from "../lib/prefs";
import { NoValue } from "../ui/primitives";

/** Row heights, matching the two density settings in index.css. */
const ROW_HEIGHT: Record<Density, number> = { compact: 28, comfortable: 34 };

export interface ResultsTableProps {
  rows: DeviceRow[];
  columns: ColumnDef[];
  columnWidths: ColumnWidths;
  onColumnWidth: (key: ColumnKey, width: number) => void;
  sortKey: ColumnKey;
  sortDir: SortDir;
  onSort: (key: ColumnKey) => void;
  density: Density;
  selected: ReadonlySet<string>;
  focusedIp: string | null;
  onRowClick: (row: DeviceRow, index: number, event: React.MouseEvent) => void;
  onRowActivate: (row: DeviceRow) => void;
  onRowContextMenu: (event: React.MouseEvent, row: DeviceRow, column: ColumnKey | null) => void;
  onKeyNav: (event: React.KeyboardEvent) => void;
}

/**
 * The results table.
 *
 * Three things here are what make it usable on a real network rather than a
 * demo of ten devices:
 *
 * * Fixed layout with an explicit `colgroup`, so a column keeps its width while
 *   rows stream in and a long hostname cannot reflow the whole table.
 * * Rows are memoised on their own data, so an event about one device repaints
 *   one row rather than the table.
 * * Above 150 rows only the visible window is in the DOM (see
 *   `useVirtualRows`), which is what keeps a /22 scrolling smoothly.
 */
export function ResultsTable({
  rows,
  columns,
  columnWidths,
  onColumnWidth,
  sortKey,
  sortDir,
  onSort,
  density,
  selected,
  focusedIp,
  onRowClick,
  onRowActivate,
  onRowContextMenu,
  onKeyNav,
}: ResultsTableProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const rowHeight = ROW_HEIGHT[density];
  const window_ = useVirtualRows(scroller, rows.length, rowHeight);

  const widths = useMemo(
    () =>
      columns.map((column) => ({
        key: column.key,
        width: columnWidths[column.key] ?? column.width,
        flexible: column.flexible === true,
      })),
    [columns, columnWidths],
  );

  /**
   * The narrowest the table may be drawn.
   *
   * Without it, a fixed-layout table squeezes every column to fit the window,
   * so opening the details drawer would crush the MAC address and the service
   * list into ellipses. With it the container scrolls sideways instead and
   * every column keeps the width it was given -- which is also what makes a
   * resize a consultant performed stick.
   */
  const minTableWidth = useMemo(
    () => widths.reduce((total, column) => total + column.width, 0),
    [widths],
  );

  const visible = rows.slice(window_.start, window_.end);

  return (
    <div
      ref={scroller}
      className="min-h-0 flex-1 overflow-auto bg-canvas"
      tabIndex={0}
      role="grid"
      aria-label="Discovered devices"
      aria-rowcount={rows.length}
      aria-activedescendant={focusedIp ? rowDomId(focusedIp) : undefined}
      onKeyDown={onKeyNav}
    >
      <table className={`results-table density-${density}`} style={{ minWidth: minTableWidth }}>
        <colgroup>
          {widths.map((column) =>
            // A fixed-layout table gives every sized column exactly its width
            // and hands what is left to the one column with no width at all.
            column.flexible ? (
              <col key={column.key} />
            ) : (
              <col key={column.key} style={{ width: column.width }} />
            ),
          )}
        </colgroup>

        <thead>
          <tr>
            {columns.map((column) => (
              <HeaderCell
                key={column.key}
                column={column}
                width={columnWidths[column.key] ?? column.width}
                sorted={sortKey === column.key}
                sortDir={sortDir}
                onSort={onSort}
                onWidth={onColumnWidth}
              />
            ))}
          </tr>
        </thead>

        <tbody>
          {window_.padTop > 0 ? (
            <tr aria-hidden style={{ height: window_.padTop }}>
              <td colSpan={columns.length} className="border-none p-0" />
            </tr>
          ) : null}

          {visible.map((row, offset) => (
            <Row
              key={row.host.ip}
              row={row}
              index={window_.start + offset}
              columns={columns}
              selected={selected.has(row.host.ip)}
              focused={focusedIp === row.host.ip}
              onClick={onRowClick}
              onActivate={onRowActivate}
              onContextMenu={onRowContextMenu}
            />
          ))}

          {window_.padBottom > 0 ? (
            <tr aria-hidden style={{ height: window_.padBottom }}>
              <td colSpan={columns.length} className="border-none p-0" />
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function HeaderCell({
  column,
  width,
  sorted,
  sortDir,
  onSort,
  onWidth,
}: {
  column: ColumnDef;
  width: number;
  sorted: boolean;
  sortDir: SortDir;
  onSort: (key: ColumnKey) => void;
  onWidth: (key: ColumnKey, width: number) => void;
}) {
  const [dragging, setDragging] = useState(false);

  /**
   * Resize by pointer capture rather than by listening on the window: capture
   * keeps the drag working when the pointer leaves the header, and releases it
   * automatically if the pointer is lost.
   */
  const startResize = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = width;
      const handle = event.currentTarget as HTMLElement;
      handle.setPointerCapture(event.pointerId);
      setDragging(true);

      const onMove = (move: PointerEvent) => {
        const next = Math.max(column.minWidth, Math.round(startWidth + move.clientX - startX));
        onWidth(column.key, next);
      };
      const onUp = () => {
        setDragging(false);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    },
    [column.key, column.minWidth, onWidth, width],
  );

  const SortIcon = sortDir === "asc" ? ArrowUp : ArrowDown;
  const label = column.label || "Status";

  return (
    <th
      scope="col"
      className="relative"
      aria-sort={sorted ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
      style={column.align === "right" ? { textAlign: "right" } : undefined}
    >
      <button
        type="button"
        className={`flex h-full w-full items-center gap-1 overflow-hidden text-[11px] font-semibold uppercase tracking-wide ${
          column.align === "right" ? "justify-end" : ""
        } ${sorted ? "text-ink" : "text-ink-muted hover:text-ink"}`}
        onClick={() => onSort(column.key)}
        title={column.hint ? `${label} — ${column.hint}` : `Sort by ${label.toLowerCase()}`}
      >
        <span className="truncate">{column.label}</span>
        {sorted ? <SortIcon size={11} className="shrink-0" aria-hidden /> : null}
      </button>
      <span
        className="col-resizer"
        data-dragging={dragging || undefined}
        onPointerDown={startResize}
        onDoubleClick={() => onWidth(column.key, column.width)}
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${label} column`}
        title="Drag to resize, double-click to reset"
      />
    </th>
  );
}

interface RowProps {
  row: DeviceRow;
  index: number;
  columns: ColumnDef[];
  selected: boolean;
  focused: boolean;
  onClick: (row: DeviceRow, index: number, event: React.MouseEvent) => void;
  onActivate: (row: DeviceRow) => void;
  onContextMenu: (event: React.MouseEvent, row: DeviceRow, column: ColumnKey | null) => void;
}

/**
 * One device row.
 *
 * Memoised, so the hundred update events a scan produces repaint the hundred
 * rows they name and nothing else. The comparison is on the fields actually
 * rendered rather than on object identity, because the merge in `live.ts`
 * builds a new host object for every update.
 */
const Row = memo(
  function Row({ row, index, columns, selected, focused, onClick, onActivate, onContextMenu }: RowProps) {
    return (
      <tr
        id={rowDomId(row.host.ip)}
        role="row"
        aria-selected={selected}
        aria-rowindex={index + 2}
        tabIndex={-1}
        onClick={(event) => onClick(row, index, event)}
        onDoubleClick={() => onActivate(row)}
        onContextMenu={(event) => onContextMenu(event, row, columnFromEvent(event, columns))}
        title="Double-click for device details · Right-click for actions"
        className={`cursor-default${row.watchState ? ` watch-row-${row.watchState}` : ""}`}
        style={
          focused
            ? { outline: "2px solid var(--color-accent)", outlineOffset: "-2px" }
            : undefined
        }
      >
        {columns.map((column) => (
          <Cell key={column.key} row={row} column={column} />
        ))}
      </tr>
    );
  },
  (prev, next) =>
    prev.selected === next.selected &&
    prev.focused === next.focused &&
    prev.index === next.index &&
    prev.columns === next.columns &&
    prev.row.pending === next.row.pending &&
    prev.row.watchState === next.row.watchState &&
    sameHost(prev.row, next.row),
);

/** A stable DOM id per device, for `aria-activedescendant` and scrolling. */
function rowDomId(ip: string): string {
  return `device-${ip.replace(/\./g, "-")}`;
}

/**
 * Which column a right-click landed in.
 *
 * Read from the event's own cell rather than tracked in state, so Copy cell
 * refers to the value the consultant was actually pointing at.
 */
function columnFromEvent(event: React.MouseEvent, columns: ColumnDef[]): ColumnKey | null {
  const cell = (event.target as HTMLElement | null)?.closest("td");
  if (!cell) return null;
  return columns[cell.cellIndex]?.key ?? null;
}

function sameHost(a: DeviceRow, b: DeviceRow): boolean {
  return (
    a.host.ip === b.host.ip &&
    a.host.hostname === b.host.hostname &&
    a.host.mac === b.host.mac &&
    a.host.vendor === b.host.vendor &&
    a.host.latency_ms === b.host.latency_ms &&
    a.host.os_hint === b.host.os_hint &&
    a.host.open_ports.length === b.host.open_ports.length &&
    a.host.open_ports.every((port, i) => port === b.host.open_ports[i])
  );
}

function Cell({ row, column }: { row: DeviceRow; column: ColumnDef }) {
  const align = column.align === "right" ? { textAlign: "right" as const } : undefined;

  switch (column.key) {
    case "status":
      return (
        <td style={align}>
          <StatusDot row={row} />
        </td>
      );

    case "ip":
      return (
        <td className="mono" style={align}>
          {row.host.ip}
        </td>
      );

    case "hostname": {
      const name = row.host.hostname?.trim();
      return (
        <td style={align} title={name || undefined}>
          {name ? (
            name
          ) : row.pending ? (
            <span className="no-value italic">resolving…</span>
          ) : (
            <NoValue title="No reverse DNS record for this address" />
          )}
        </td>
      );
    }

    case "mac": {
      const mac = row.host.mac?.trim();
      return (
        <td className="mono" style={align}>
          {mac ? (
            mac
          ) : row.pending ? (
            <span className="no-value italic">resolving…</span>
          ) : (
            <NoValue title="A MAC address is only visible for devices on your own network segment" />
          )}
        </td>
      );
    }

    case "vendor": {
      const vendor = row.host.vendor?.trim();
      return (
        <td style={align} title={vendor || undefined}>
          {vendor ? (
            vendor
          ) : row.pending ? (
            // The manufacturer comes from the MAC address, so it arrives at the
            // same moment and must not read as "none" before then.
            <span className="no-value italic">resolving…</span>
          ) : (
            <NoValue title="No manufacturer is registered for this MAC prefix" />
          )}
        </td>
      );
    }

    case "latency": {
      if (row.watchState === "offline") {
        return (
          <td className="mono text-danger" style={align} title="Not found in the latest Watch scan">
            offline
          </td>
        );
      }
      const latency = formatLatency(row.host.latency_ms);
      return (
        <td className="mono" style={align}>
          {latency ?? <NoValue title="This device did not answer a ping or a TCP probe" />}
        </td>
      );
    }

    case "os": {
      const hint = row.host.os_hint;
      return (
        <td style={align} title={hint ? `${hint} — estimated from the reply TTL` : undefined}>
          {hint ? (
            <span className="text-ink-soft">{hint}</span>
          ) : (
            <NoValue title="Not enough information to estimate" />
          )}
        </td>
      );
    }

    case "ports":
      return (
        <td style={align}>
          <ServiceList ports={row.host.open_ports} pending={row.pending} />
        </td>
      );
  }
}

function StatusDot({ row }: { row: DeviceRow }) {
  if (row.watchState === "new") {
    return (
      <span
        className="inline-flex text-ok"
        title="New since the previous Watch scan"
        aria-label="New device"
      >
        <CirclePlus size={14} aria-hidden />
      </span>
    );
  }
  if (row.watchState === "changed") {
    return (
      <span
        className="inline-flex text-warn"
        title="Device details changed since the previous Watch scan"
        aria-label="Changed device"
      >
        <RefreshCw size={13} aria-hidden />
      </span>
    );
  }
  if (row.watchState === "offline") {
    return (
      <span
        className="inline-flex text-danger"
        title="Not found in the latest Watch scan"
        aria-label="Offline device"
      >
        <CircleSlash size={14} aria-hidden />
      </span>
    );
  }

  if (row.host.is_self) {
    return (
      <span
        className="inline-block size-2 rounded-full"
        style={{
          background: "var(--color-accent)",
          boxShadow: "0 0 0 3px var(--accent-soft)",
        }}
        title="This computer"
        aria-label="This computer"
      />
    );
  }
  if (isResponding(row)) {
    return (
      <span
        className="inline-block size-2 rounded-full"
        style={{ background: "var(--color-ok)" }}
        title="Responding to ping or TCP"
        aria-label="Responding"
      />
    );
  }
  return (
    <span
      className="inline-block size-2 rounded-full border"
      style={{ borderColor: "var(--color-quiet)" }}
      title="Found on the network, but it answered no probes. Normal for printers and hardened hosts."
      aria-label="Quiet"
    />
  );
}

/**
 * The Open Ports cell.
 *
 * Every port is shown with its service word, because `445 SMB` tells a
 * consultant something `445` does not. The ports that lead to an action are
 * tinted, which is what makes a server, a printer and a switch
 * distinguishable while scrolling a full table.
 */
/**
 * How many service chips one cell shows before the rest are summarised.
 *
 * A domain controller answers on seven or eight of the default ports, which is
 * more than fits. Silently clipping them at the cell edge would leave a
 * consultant unsure whether they were seeing everything, so the overflow is
 * counted explicitly and the full list is one double-click away in the details
 * panel.
 */
const MAX_CHIPS = 6;

function ServiceList({ ports, pending }: { ports: number[]; pending: boolean }) {
  if (ports.length === 0) {
    return pending ? (
      <span className="no-value italic">scanning…</span>
    ) : (
      <NoValue title="No open ports were found among the ports scanned" />
    );
  }

  const shown = ports.slice(0, MAX_CHIPS);
  const hidden = ports.slice(MAX_CHIPS);

  return (
    <span className="flex items-center gap-1 overflow-hidden">
      {shown.map((port) => {
        const name = serviceName(port);
        return (
          <span
            key={port}
            className={`service-chip ${isActionablePort(port) ? "service-chip-actionable" : ""}`}
            title={name ? `Port ${port} — ${name}` : `Port ${port}`}
          >
            <span className="service-chip-port">{port}</span>
            {name ? <span>{name}</span> : null}
          </span>
        );
      })}
      {hidden.length > 0 ? (
        <span
          className="service-chip"
          title={`Also open: ${hidden.map((p) => (serviceName(p) ? `${p} ${serviceName(p)}` : String(p))).join(", ")}`}
        >
          +{hidden.length}
        </span>
      ) : null}
    </span>
  );
}

/** Re-exported so App has one import for the table's own vocabulary. */
export { COLUMNS, rowName };
