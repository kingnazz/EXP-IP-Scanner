import { useEffect } from "react";

export interface Hotkeys {
  /** Ctrl+F, or F3: focus the search field. */
  onSearch?: () => void;
  /** Ctrl+L: focus the target field. */
  onFocusTarget?: () => void;
  /** F5, or Ctrl+R: start a scan. */
  onScan?: () => void;
  /** Escape: stop a scan, or close whatever is open. */
  onEscape?: () => void;
  /** Ctrl+E: export CSV. */
  onExport?: () => void;
  /** Ctrl+C with a selection: copy the selected rows. */
  onCopy?: () => void;
  /** Ctrl+A: select every visible row. */
  onSelectAll?: () => void;
}

/** True when the event came from somewhere the user is typing. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/**
 * The application's keyboard shortcuts.
 *
 * Chosen to be the ones a Windows consultant already knows, so nothing has to
 * be learned: Ctrl+F to search, F5 to scan, Escape to stop, Ctrl+E to export.
 * A shortcut that would interfere with typing is suppressed while a field has
 * focus, except the ones whose whole purpose is to move focus.
 */
export function useHotkeys(keys: Hotkeys): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const ctrl = event.ctrlKey || event.metaKey;
      const typing = isTypingTarget(event.target);

      if (event.key === "Escape") {
        keys.onEscape?.();
        return;
      }
      if (ctrl && event.key.toLowerCase() === "f") {
        event.preventDefault();
        keys.onSearch?.();
        return;
      }
      if (event.key === "F3") {
        event.preventDefault();
        keys.onSearch?.();
        return;
      }
      if (ctrl && event.key.toLowerCase() === "l") {
        event.preventDefault();
        keys.onFocusTarget?.();
        return;
      }
      if (event.key === "F5" || (ctrl && event.key.toLowerCase() === "r")) {
        event.preventDefault();
        keys.onScan?.();
        return;
      }
      if (ctrl && event.key.toLowerCase() === "e") {
        event.preventDefault();
        keys.onExport?.();
        return;
      }
      // Copy and Select all belong to the field while one has focus.
      if (typing) return;
      if (ctrl && event.key.toLowerCase() === "c") {
        keys.onCopy?.();
        return;
      }
      if (ctrl && event.key.toLowerCase() === "a") {
        event.preventDefault();
        keys.onSelectAll?.();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keys]);
}
