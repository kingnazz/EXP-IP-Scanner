// The one screen.
//
// App composes and owns cross-cutting state -- which network, which devices
// are selected, what is open -- and delegates everything else. Scan mechanics
// live in `useScan`, sorting and filtering in `lib/table`, action enablement in
// `lib/actions`, the backend boundary in `lib/api`. Nothing here decides
// anything that could be tested without a browser.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AboutDialog } from "./components/AboutDialog";
import { ContextMenu } from "./components/ContextMenu";
import { DeviceDrawer } from "./components/DeviceDrawer";
import { NoMatchesState, ReadyState } from "./components/EmptyState";
import { NetworkSummary } from "./components/NetworkSummary";
import { ProgressStrip } from "./components/ProgressStrip";
import { ResultsTable } from "./components/ResultsTable";
import { ResultsToolbar } from "./components/ResultsToolbar";
import { ScanBar } from "./components/ScanBar";
import { SettingsDialog } from "./components/SettingsDialog";
import { TopBar } from "./components/TopBar";
import { useContextMenu } from "./hooks/useContextMenu";
import { useHotkeys } from "./hooks/useHotkeys";
import { usePublicIp } from "./hooks/usePublicIp";
import { useScan } from "./hooks/useScan";
import { useSettings } from "./hooks/useSettings";
import { useTheme } from "./hooks/useTheme";
import type { DeviceAction } from "./lib/actions";
import { api } from "./lib/api";
import type { UpdateCheckResult } from "./lib/update";
import {
  buildClipboardTable,
  buildCsv,
  buildDeviceDetails,
  buildIpList,
  csvFilename,
} from "./lib/export";
import { parsePorts, setServiceCatalog } from "./lib/format";
import type { DeviceRow } from "./lib/live";
import { loadRecentTargets, pushRecentTarget } from "./lib/prefs";
import {
  cellText,
  filterRows,
  prepareRows,
  visibleColumns,
  type ColumnKey,
  type FilterMode,
} from "./lib/table";
import { ToastStack, useToasts } from "./ui/Toast";
import type { LocalNetwork, PingOutcome, RuntimeInfo, ScanOptions } from "./types";
import { APP_VERSION } from "./version";

export default function App() {
  const toasts = useToasts();
  const { settings, update, restoreScanDefaults, columnWidths, setColumnWidth, resetColumnWidths, toggleColumn } =
    useSettings();
  useTheme(settings.theme);

  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [networks, setNetworks] = useState<LocalNetwork[]>([]);
  const [selectedNetwork, setSelectedNetwork] = useState<LocalNetwork | null>(null);
  const [defaultPorts, setDefaultPorts] = useState<number[]>([]);

  const [target, setTarget] = useState("");
  const [targetError, setTargetError] = useState<string | null>(null);
  const [addressCount, setAddressCount] = useState<number | null>(null);
  const [workloadWarning, setWorkloadWarning] = useState<string | null>(null);
  const [recentTargets, setRecentTargets] = useState<string[]>(() => loadRecentTargets());

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterMode>("all");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [focusedIp, setFocusedIp] = useState<string | null>(null);
  const [drawerIp, setDrawerIp] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [availableUpdate, setAvailableUpdate] = useState<UpdateCheckResult | null>(null);
  const [pingResult, setPingResult] = useState<PingOutcome | null>(null);
  const [pinging, setPinging] = useState(false);
  const [menuColumn, setMenuColumn] = useState<ColumnKey | null>(null);

  const targetInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const selectionAnchor = useRef<number | null>(null);

  const onScanError = useCallback((message: string) => toasts.error(message), [toasts]);
  const scan = useScan({ onError: onScanError });
  const menu = useContextMenu<DeviceRow>();
  // Deliberately outside the startup effect below: the window is usable, and a
  // scan can already be running, while this is still in flight.
  const publicIp = usePublicIp(settings.lookupPublicIp);

  // --- Startup -------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [info, nets, services, ports] = await Promise.all([
        api.runtimeInfo().catch(() => null),
        api.detectNetworks().catch(() => [] as LocalNetwork[]),
        api.serviceCatalog().catch(() => []),
        api.defaultPorts().catch(() => [] as number[]),
      ]);
      if (cancelled) return;
      setServiceCatalog(services);
      setRuntime(info);
      setNetworks(nets);
      setDefaultPorts(ports);

      // The target is filled in from the best interface before the technician
      // touches anything, which is the whole of the first-run experience:
      // open the app, press Scan. A remembered adapter wins, so someone who
      // works from a USB NIC does not re-pick it every launch.
      const remembered = settings.preferredInterface
        ? nets.find((n) => n.interface === settings.preferredInterface)
        : undefined;
      const chosen = remembered ?? nets[0] ?? null;
      setSelectedNetwork(chosen);
      if (chosen) setTarget(chosen.suggested_cidr);
      else if (nets.length === 0) {
        toasts.info(
          "No usable network adapter was found. Type a network to scan, or connect to a network and reopen the app.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
    // Startup runs once; the settings read here is the value it had at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The installed edition makes one quiet update check after startup. A newer
  // release is surfaced in the title bar instead of interrupting the scan with
  // a modal or toast. Portable builds never enter this path.
  useEffect(() => {
    if (!api.native || runtime?.update_mode !== "installer") return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api
        .checkForUpdate()
        .then((result) => {
          if (cancelled) return;
          setAvailableUpdate(result.available ? result : null);
        })
        .catch(() => {
          // Startup update discovery is advisory. A transient GitHub/network
          // failure should not make launching a field tool feel broken; the
          // explicit Check now action in About still reports errors.
        });
    }, 1200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [runtime?.update_mode]);

  // --- Target validation and preview ---------------------------------------

  const scanOptions = useMemo((): ScanOptions => {
    const parsed = parsePorts(settings.portSpec);
    return {
      target: target.trim(),
      ports: settings.portSpec.trim().length === 0 ? [] : parsed.ports,
      timeout_ms: settings.timeoutMs,
      concurrency: settings.hostConcurrency,
      tcp_concurrency: settings.tcpConcurrency,
      ping_concurrency: settings.pingConcurrency,
      resolve_hostnames: settings.resolveHostnames,
      scan_services: settings.scanServices,
    };
  }, [target, settings]);

  useEffect(() => {
    const trimmed = target.trim();
    if (!trimmed) {
      setTargetError(null);
      setAddressCount(null);
      setWorkloadWarning(null);
      return;
    }
    let cancelled = false;
    // Debounced, so a preview is not requested for every keystroke of an
    // address that is not finished being typed yet.
    const timer = setTimeout(() => {
      void api
        .previewScan(scanOptions)
        .then((preview) => {
          if (cancelled) return;
          setTargetError(null);
          setAddressCount(preview.total);
          setWorkloadWarning(preview.warning);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setTargetError(error instanceof Error ? error.message : String(error));
          setAddressCount(null);
          setWorkloadWarning(null);
        });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [scanOptions, target]);

  // --- Rows ----------------------------------------------------------------

  const columns = useMemo(() => visibleColumns(settings.hiddenColumns), [settings.hiddenColumns]);

  const rows = useMemo(
    () => prepareRows(scan.rows, filter, query, settings.sortKey, settings.sortDir),
    [scan.rows, filter, query, settings.sortKey, settings.sortDir],
  );

  const filterCounts = useMemo(
    (): Record<FilterMode, number> => ({
      all: filterRows(scan.rows, "all", query).length,
      responding: filterRows(scan.rows, "responding", query).length,
      services: filterRows(scan.rows, "services", query).length,
    }),
    [scan.rows, query],
  );

  const drawerRow = useMemo(
    () => (drawerIp ? (scan.rows.find((row) => row.host.ip === drawerIp) ?? null) : null),
    [drawerIp, scan.rows],
  );

  /** The rows an output action applies to: the selection, or everything shown. */
  const outputRows = useMemo(
    () => (selected.size > 0 ? rows.filter((row) => selected.has(row.host.ip)) : rows),
    [rows, selected],
  );

  // --- Scanning ------------------------------------------------------------

  const startScan = useCallback(() => {
    const trimmed = target.trim();
    if (!trimmed || targetError || scan.scanning) return;
    setSelected(new Set());
    setFocusedIp(null);
    setDrawerIp(null);
    setPingResult(null);
    setRecentTargets(pushRecentTarget(trimmed));
    void scan.run({ ...scanOptions, target: trimmed });
  }, [scan, scanOptions, target, targetError]);

  const stopScan = useCallback(() => void scan.cancel(), [scan]);

  const onSelectNetwork = useCallback(
    (network: LocalNetwork) => {
      setSelectedNetwork(network);
      setTarget(network.suggested_cidr);
      update({ preferredInterface: network.interface });
    },
    [update],
  );

  const onSort = useCallback(
    (key: ColumnKey) => {
      update(
        settings.sortKey === key
          ? { sortDir: settings.sortDir === "asc" ? "desc" : "asc" }
          : { sortKey: key, sortDir: "asc" },
      );
    },
    [settings.sortDir, settings.sortKey, update],
  );

  // --- Selection -----------------------------------------------------------

  const onRowClick = useCallback(
    (row: DeviceRow, index: number, event: React.MouseEvent) => {
      setFocusedIp(row.host.ip);
      const ip = row.host.ip;

      if (event.shiftKey && selectionAnchor.current != null) {
        const [from, to] = [selectionAnchor.current, index].sort((a, b) => a - b) as [number, number];
        setSelected(new Set(rows.slice(from, to + 1).map((r) => r.host.ip)));
        return;
      }
      if (event.ctrlKey || event.metaKey) {
        setSelected((current) => {
          const next = new Set(current);
          if (next.has(ip)) next.delete(ip);
          else next.add(ip);
          return next;
        });
        selectionAnchor.current = index;
        return;
      }
      setSelected(new Set([ip]));
      selectionAnchor.current = index;
    },
    [rows],
  );

  const openDrawer = useCallback((row: DeviceRow) => {
    setDrawerIp(row.host.ip);
    setPingResult(null);
  }, []);

  const onKeyNav = useCallback(
    (event: React.KeyboardEvent) => {
      if (rows.length === 0) return;
      const current = focusedIp ? rows.findIndex((row) => row.host.ip === focusedIp) : -1;

      const move = (delta: number) => {
        event.preventDefault();
        const next = Math.min(rows.length - 1, Math.max(0, current < 0 ? 0 : current + delta));
        const row = rows[next];
        if (!row) return;
        setFocusedIp(row.host.ip);
        if (event.shiftKey && selectionAnchor.current != null) {
          const [from, to] = [selectionAnchor.current, next].sort((a, b) => a - b) as [number, number];
          setSelected(new Set(rows.slice(from, to + 1).map((r) => r.host.ip)));
        } else {
          setSelected(new Set([row.host.ip]));
          selectionAnchor.current = next;
        }
        // Keep the focused row on screen. With the window virtualised the row
        // may not be in the DOM yet, so a miss is expected and harmless: the
        // row scrolls in on the next frame either way.
        document
          .getElementById(`device-${row.host.ip.replace(/\./g, "-")}`)
          ?.scrollIntoView({ block: "nearest" });
      };

      switch (event.key) {
        case "ArrowDown":
          move(1);
          break;
        case "ArrowUp":
          move(-1);
          break;
        case "PageDown":
          move(15);
          break;
        case "PageUp":
          move(-15);
          break;
        case "Home":
          move(-rows.length);
          break;
        case "End":
          move(rows.length);
          break;
        case "Enter": {
          const row = current >= 0 ? rows[current] : undefined;
          if (row) {
            event.preventDefault();
            openDrawer(row);
          }
          break;
        }
      }
    },
    [focusedIp, openDrawer, rows],
  );

  const selectAll = useCallback(() => {
    setSelected(new Set(rows.map((row) => row.host.ip)));
  }, [rows]);

  // --- Output --------------------------------------------------------------

  const copyRows = useCallback(async () => {
    if (outputRows.length === 0) return;
    try {
      await api.copyToClipboard(buildClipboardTable(outputRows));
      toasts.success(
        `${outputRows.length} ${outputRows.length === 1 ? "row" : "rows"} copied, tab separated.`,
      );
    } catch {
      toasts.error("Windows did not allow copying to the clipboard.");
    }
  }, [outputRows, toasts]);

  const copyIps = useCallback(async () => {
    if (outputRows.length === 0) return;
    try {
      await api.copyToClipboard(buildIpList(outputRows));
      toasts.success(
        `${outputRows.length} IP ${outputRows.length === 1 ? "address" : "addresses"} copied.`,
      );
    } catch {
      toasts.error("Windows did not allow copying to the clipboard.");
    }
  }, [outputRows, toasts]);

  const exportCsv = useCallback(async () => {
    if (outputRows.length === 0) return;
    const scannedTarget = scan.summary?.target ?? target.trim();
    const csv = buildCsv(outputRows, {
      target: scannedTarget,
      scannedAt: new Date().toISOString(),
    });
    try {
      const saved = await api.saveCsv(csvFilename(scannedTarget), csv);
      if (saved) {
        toasts.success(
          `${outputRows.length} ${outputRows.length === 1 ? "device" : "devices"} exported.`,
        );
      }
    } catch (error) {
      toasts.error(error instanceof Error ? error.message : String(error));
    }
  }, [outputRows, scan.summary, target, toasts]);

  const copyText = useCallback(
    async (text: string, what: string) => {
      try {
        await api.copyToClipboard(text);
        toasts.success(`${what} copied.`);
      } catch {
        toasts.error("Windows did not allow copying to the clipboard.");
      }
    },
    [toasts],
  );

  // --- Device actions ------------------------------------------------------

  const runAction = useCallback(
    async (action: DeviceAction, host: DeviceRow["host"]) => {
      const row = scan.rows.find((r) => r.host.ip === host.ip);
      /** True when the right-clicked device is part of a multi-row selection. */
      const inSelection = selected.size > 1 && selected.has(host.ip);
      try {
        switch (action.id) {
          case "copy-cell": {
            if (!row || !action.column) return;
            const value = cellText(row, action.column);
            if (!value) {
              toasts.info("That cell is empty, so there was nothing to copy.");
              return;
            }
            await copyText(value, "Cell");
            return;
          }
          case "copy-ip":
            await copyText(host.ip, "IP address");
            return;
          case "copy-hostname":
            if (host.hostname) await copyText(host.hostname, "Hostname");
            return;
          case "copy-mac":
            if (host.mac) await copyText(host.mac, "MAC address");
            return;
          case "copy-row": {
            // Right-clicking inside a multi-row selection copies the whole
            // selection, which is what somebody who just selected five devices
            // means by Copy.
            if (inSelection) {
              await copyRows();
              return;
            }
            if (row) await copyText(buildClipboardTable([row]), "Row");
            return;
          }
          case "copy-details":
            if (row) await copyText(buildDeviceDetails(row), "Device details");
            return;
          case "ping": {
            setPinging(true);
            setPingResult(null);
            setDrawerIp(host.ip);
            try {
              setPingResult(await api.ping(host.ip));
            } finally {
              setPinging(false);
            }
            return;
          }
          case "ping-console":
            await api.openPingConsole(host.ip);
            return;
          case "traceroute":
            await api.openTracerouteConsole(host.ip);
            return;
          case "web":
            await api.openWeb(host.ip, action.port ?? null);
            return;
          case "smb":
            await api.openSmb(host.ip);
            return;
          case "rdp":
            await api.openRdp(host.ip);
            return;
          case "ssh":
            await api.openSsh(host.ip);
            return;
          case "vnc":
            await api.openVnc(host.ip, action.port ?? null);
            return;
        }
      } catch (error) {
        toasts.error(error instanceof Error ? error.message : String(error));
      }
    },
    [copyRows, copyText, scan.rows, selected, toasts],
  );

  // --- Keyboard ------------------------------------------------------------

  useHotkeys(
    useMemo(
      () => ({
        onSearch: () => searchInput.current?.select(),
        onFocusTarget: () => targetInput.current?.select(),
        onScan: () => (scan.scanning ? stopScan() : startScan()),
        onEscape: () => {
          if (menu.state) menu.close();
          else if (scan.scanning) stopScan();
          else if (drawerIp) setDrawerIp(null);
          else if (query) setQuery("");
        },
        onExport: () => void exportCsv(),
        onCopy: () => void copyRows(),
        onSelectAll: selectAll,
      }),
      [copyRows, drawerIp, exportCsv, menu, query, scan.scanning, selectAll, startScan, stopScan],
    ),
  );

  // --- Render --------------------------------------------------------------

  const showResults = scan.rows.length > 0 || scan.scanning;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <TopBar
        theme={settings.theme}
        onThemeChange={(theme) => update({ theme })}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenAbout={() => setAboutOpen(true)}
        version={runtime?.version ?? APP_VERSION}
        edition={runtime && runtime.edition === "portable" ? runtime.edition_label : null}
        updateVersion={availableUpdate?.version ?? null}
      />

      <ScanBar
        ref={targetInput}
        networks={networks}
        selectedNetwork={selectedNetwork}
        onSelectNetwork={onSelectNetwork}
        target={target}
        onTargetChange={setTarget}
        targetError={targetError}
        recentTargets={recentTargets}
        scanning={scan.scanning}
        stopping={scan.stopping}
        onScan={startScan}
        onStop={stopScan}
      />

      <NetworkSummary
        network={selectedNetwork}
        target={target.trim()}
        addressCount={addressCount}
        publicIp={publicIp.state}
        onRefreshPublicIp={publicIp.refresh}
        onCopy={(value, what) => void copyText(value, what)}
      />

      <div className="flex min-h-0 flex-1">
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {showResults ? (
            <>
              <ResultsToolbar
                ref={searchInput}
                query={query}
                onQueryChange={setQuery}
                filter={filter}
                onFilterChange={setFilter}
                counts={filterCounts}
                selectedCount={selected.size}
                rowCount={scan.rows.length}
                hiddenColumns={settings.hiddenColumns}
                onToggleColumn={toggleColumn}
                onResetColumns={resetColumnWidths}
                onExport={() => void exportCsv()}
                onCopy={() => void copyRows()}
                onCopyIps={() => void copyIps()}
                onClear={() => {
                  scan.clear();
                  setSelected(new Set());
                  setFocusedIp(null);
                  setDrawerIp(null);
                  setQuery("");
                }}
              />
              {rows.length > 0 ? (
                <ResultsTable
                  rows={rows}
                  columns={columns}
                  columnWidths={columnWidths}
                  onColumnWidth={setColumnWidth}
                  sortKey={settings.sortKey}
                  sortDir={settings.sortDir}
                  onSort={onSort}
                  density={settings.density}
                  selected={selected}
                  focusedIp={focusedIp}
                  onRowClick={onRowClick}
                  onRowActivate={openDrawer}
                  onRowContextMenu={(event, row, column) => {
                    setFocusedIp(row.host.ip);
                    if (!selected.has(row.host.ip)) setSelected(new Set([row.host.ip]));
                    setMenuColumn(column);
                    menu.open(event, row);
                  }}
                  onKeyNav={onKeyNav}
                />
              ) : (
                <NoMatchesState query={query} onClearSearch={() => setQuery("")} />
              )}
            </>
          ) : (
            <ReadyState
              target={target.trim()}
              addressCount={addressCount}
              warning={workloadWarning}
              disabled={Boolean(targetError) || target.trim().length === 0}
              onScan={startScan}
            />
          )}
        </main>

        {drawerRow ? (
          <DeviceDrawer
            row={drawerRow}
            network={selectedNetwork}
            onClose={() => setDrawerIp(null)}
            onAction={(action) => void runAction(action, drawerRow.host)}
            pingResult={pingResult}
            pinging={pinging}
          />
        ) : null}
      </div>

      <ProgressStrip
        scanning={scan.scanning}
        stopping={scan.stopping}
        progress={scan.progress}
        started={scan.started}
        summary={scan.summary}
        shownCount={rows.length}
        totalCount={scan.rows.length}
      />

      {menu.state ? (
        <ContextMenu
          anchor={menu.state.anchor}
          host={menu.state.item.host}
          cellColumn={menuColumn}
          selectionCount={selected.size}
          onAction={(action, host) => void runAction(action, host)}
          onClose={menu.close}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsDialog
          settings={settings}
          defaultPorts={defaultPorts}
          onChange={update}
          onRestoreDefaults={restoreScanDefaults}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {aboutOpen ? (
        <AboutDialog
          runtime={runtime}
          knownUpdate={availableUpdate}
          onClose={() => setAboutOpen(false)}
          onError={(message) => toasts.error(message)}
        />
      ) : null}

      <ToastStack toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </div>
  );
}
