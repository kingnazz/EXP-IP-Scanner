import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ALL_ROWS,
  SILENT_PRINTER,
  THIS_COMPUTER,
  WINDOWS_SERVER,
  row,
} from "../test/devices";
import { prepareRows, visibleColumns, DEFAULT_HIDDEN_COLUMNS } from "../lib/table";
import { ResultsTable } from "./ResultsTable";

function renderTable(overrides: Partial<Parameters<typeof ResultsTable>[0]> = {}) {
  // The spies are named separately from the props, so they keep their mock
  // type rather than widening to a union with the real prop signature.
  const spies = {
    onColumnWidth: vi.fn(),
    onSort: vi.fn(),
    onRowClick: vi.fn(),
    onRowActivate: vi.fn(),
    onRowContextMenu: vi.fn(),
    onKeyNav: vi.fn(),
  };
  const props: Parameters<typeof ResultsTable>[0] = {
    rows: prepareRows(ALL_ROWS, "all", "", "ip", "asc"),
    columns: visibleColumns(DEFAULT_HIDDEN_COLUMNS),
    columnWidths: {},
    sortKey: "ip",
    sortDir: "asc",
    density: "compact",
    selected: new Set<string>(),
    focusedIp: null,
    ...spies,
    ...overrides,
  };
  return { ...render(<ResultsTable {...props} />), spies };
}

const bodyRows = () =>
  Array.from(document.querySelectorAll("tbody tr[aria-rowindex]")) as HTMLTableRowElement[];

describe("the rendered table", () => {
  it("renders one row per device, in numeric address order", () => {
    renderTable();
    const addresses = bodyRows().map((tr) => tr.cells[1]?.textContent);
    expect(addresses).toEqual([
      "192.168.50.1",
      "192.168.50.9",
      "192.168.50.10",
      "192.168.50.26",
      "192.168.50.27",
      "192.168.50.31",
      "192.168.50.37",
      "192.168.50.51",
      "192.168.50.100",
    ]);
  });

  it("shows the default columns and hides the device-type guess", () => {
    renderTable();
    expect(screen.getByRole("columnheader", { name: /IP address/i })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /Hostname/i })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /MAC address/i })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /Manufacturer/i })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /Latency/i })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /Open ports/i })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: /Device type/i })).toBeNull();
  });

  it("shows a port with its service name, not a bare number", () => {
    renderTable();
    const server = bodyRows().find((tr) => tr.cells[1]?.textContent === WINDOWS_SERVER.ip);
    const ports = server?.cells[server.cells.length - 1];
    expect(ports?.textContent).toContain("3389");
    expect(ports?.textContent).toContain("RDP");
    expect(ports?.textContent).toContain("445");
    expect(ports?.textContent).toContain("SMB");
  });

  it("summarises the overflow rather than clipping it silently", () => {
    // The domain controller has seven open ports, which is more than fits.
    renderTable();
    const server = bodyRows().find((tr) => tr.cells[1]?.textContent === WINDOWS_SERVER.ip);
    const ports = server?.cells[server.cells.length - 1];
    expect(ports?.textContent).toContain("+1");
    // And the ones it did not show are named in the tooltip.
    const overflow = within(ports as HTMLElement).getByTitle(/Also open/);
    expect(overflow.getAttribute("title")).toContain("5985 WinRM");
  });

  it("marks a device found only through ARP as quiet rather than missing", () => {
    renderTable();
    const quiet = bodyRows().find((tr) => tr.cells[1]?.textContent === SILENT_PRINTER.ip);
    expect(within(quiet as HTMLElement).getByLabelText("Quiet")).toBeTruthy();
    // Its manufacturer is still known, because ARP gave up a MAC.
    expect(quiet?.cells[4]?.textContent).toBe("Xerox");
  });

  it("marks this computer", () => {
    renderTable();
    const self = bodyRows().find((tr) => tr.cells[1]?.textContent === THIS_COMPUTER.ip);
    expect(within(self as HTMLElement).getByLabelText("This computer")).toBeTruthy();
  });

  it("shows a dash, not a blank, where a device has no value", () => {
    renderTable();
    const quiet = bodyRows().find((tr) => tr.cells[1]?.textContent === SILENT_PRINTER.ip);
    // Hostname and latency are both absent for this device.
    expect(quiet?.cells[2]?.textContent).toBe("—");
    expect(quiet?.cells[5]?.textContent).toBe("—");
  });

  it("says a value is still resolving while the scan is running", () => {
    renderTable({
      rows: [row({ ip: "10.0.0.5", open_ports: [80], latency_ms: 2 }, true)],
    });
    const cells = bodyRows()[0]?.cells;
    expect(cells?.[2]?.textContent).toBe("resolving…");
    expect(cells?.[3]?.textContent).toBe("resolving…");
    // The manufacturer comes from the MAC, so it resolves at the same moment.
    expect(cells?.[4]?.textContent).toBe("resolving…");
  });
});

describe("selection and sorting", () => {
  it("reports the selected rows to assistive technology", () => {
    renderTable({ selected: new Set([WINDOWS_SERVER.ip, THIS_COMPUTER.ip]) });
    const selected = bodyRows().filter((tr) => tr.getAttribute("aria-selected") === "true");
    expect(selected.map((tr) => tr.cells[1]?.textContent)).toEqual([
      WINDOWS_SERVER.ip,
      THIS_COMPUTER.ip,
    ]);
  });

  it("announces which column the table is sorted by", () => {
    renderTable({ sortKey: "latency", sortDir: "desc" });
    const latency = screen.getByRole("columnheader", { name: /Latency/i });
    expect(latency.getAttribute("aria-sort")).toBe("descending");
    expect(
      screen.getByRole("columnheader", { name: /IP address/i }).getAttribute("aria-sort"),
    ).toBe("none");
  });

  it("asks to re-sort when a header is clicked", () => {
    const { spies } = renderTable();
    const header = screen.getByRole("columnheader", { name: /Latency/i });
    within(header).getByRole("button").click();
    expect(spies.onSort).toHaveBeenCalledWith("latency");
  });

  it("offers a resize handle on every column", () => {
    renderTable();
    const handles = screen.getAllByRole("separator");
    expect(handles).toHaveLength(visibleColumns(DEFAULT_HIDDEN_COLUMNS).length);
    expect(handles[1]?.getAttribute("aria-label")).toBe("Resize IP address column");
  });

  it("points assistive technology at the focused row", () => {
    renderTable({ focusedIp: WINDOWS_SERVER.ip });
    const grid = screen.getByRole("grid");
    expect(grid.getAttribute("aria-activedescendant")).toBe("device-192-168-50-10");
    expect(document.getElementById("device-192-168-50-10")).toBeTruthy();
  });

  it("opens a device on double-click", () => {
    const { spies } = renderTable();
    const server = bodyRows().find((tr) => tr.cells[1]?.textContent === WINDOWS_SERVER.ip);
    server?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(spies.onRowActivate).toHaveBeenCalledOnce();
    expect(spies.onRowActivate.mock.calls[0]?.[0].host.ip).toBe(WINDOWS_SERVER.ip);
  });

  it("hands keyboard events to the caller so the whole grid is navigable", () => {
    const { spies } = renderTable();
    const grid = screen.getByRole("grid");
    expect(grid.getAttribute("tabindex")).toBe("0");
    expect(grid.getAttribute("aria-rowcount")).toBe(String(ALL_ROWS.length));
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(spies.onKeyNav).toHaveBeenCalled();
  });
});

describe("large result sets", () => {
  it("keeps only the visible window in the DOM", () => {
    // A /22 with several hundred devices is realistic, and a table that keeps
    // every row rendered stops scrolling smoothly well before that.
    const many = Array.from({ length: 900 }, (_, i) =>
      row({
        ip: `10.4.${Math.floor(i / 254)}.${(i % 254) + 1}`,
        open_ports: [80],
        latency_ms: 1 + i / 100,
      }),
    );
    renderTable({ rows: prepareRows(many, "all", "", "ip", "asc") });

    const rendered = bodyRows().length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(many.length);
    // The rows that are not rendered are accounted for by spacers, so the
    // scrollbar still reflects the real length.
    const spacers = document.querySelectorAll('tbody tr[aria-hidden="true"]');
    expect(spacers.length).toBeGreaterThan(0);
  });

  it("renders a short table in full, so find-in-page still works", () => {
    renderTable();
    expect(bodyRows()).toHaveLength(ALL_ROWS.length);
    expect(document.querySelectorAll('tbody tr[aria-hidden="true"]')).toHaveLength(0);
  });
});
