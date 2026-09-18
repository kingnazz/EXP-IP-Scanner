import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_SETTINGS,
  loadColumnWidths,
  loadSettings,
  saveColumnWidths,
  saveSettings,
  type ColumnWidths,
  type Settings,
} from "../lib/prefs";
import type { ColumnKey } from "../lib/table";

/**
 * Settings and column widths, read once and written back as they change.
 *
 * Writes are debounced only for column widths, which change on every frame of
 * a drag; everything else is a deliberate act and is saved immediately.
 */
export function useSettings() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>(() => loadColumnWidths());

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    const timer = setTimeout(() => saveColumnWidths(columnWidths), 200);
    return () => clearTimeout(timer);
  }, [columnWidths]);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  }, []);

  /** Restore every scan setting, leaving the theme and table layout alone. */
  const restoreScanDefaults = useCallback(() => {
    setSettings((current) => ({
      ...current,
      timeoutMs: DEFAULT_SETTINGS.timeoutMs,
      hostConcurrency: DEFAULT_SETTINGS.hostConcurrency,
      tcpConcurrency: DEFAULT_SETTINGS.tcpConcurrency,
      pingConcurrency: DEFAULT_SETTINGS.pingConcurrency,
      portSpec: DEFAULT_SETTINGS.portSpec,
      resolveHostnames: DEFAULT_SETTINGS.resolveHostnames,
      scanServices: DEFAULT_SETTINGS.scanServices,
    }));
  }, []);

  const setColumnWidth = useCallback((key: ColumnKey, width: number) => {
    setColumnWidths((current) => ({ ...current, [key]: width }));
  }, []);

  const resetColumnWidths = useCallback(() => setColumnWidths({}), []);

  const toggleColumn = useCallback((key: ColumnKey) => {
    setSettings((current) => ({
      ...current,
      hiddenColumns: current.hiddenColumns.includes(key)
        ? current.hiddenColumns.filter((c) => c !== key)
        : [...current.hiddenColumns, key],
    }));
  }, []);

  return {
    settings,
    update,
    restoreScanDefaults,
    columnWidths,
    setColumnWidth,
    resetColumnWidths,
    toggleColumn,
  };
}
