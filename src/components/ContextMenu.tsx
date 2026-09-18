import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MenuAnchor } from "../hooks/useContextMenu";
import { deviceActions, type ActionGroup, type DeviceAction } from "../lib/actions";
import type { ColumnKey } from "../lib/table";
import type { HostResult } from "../types";

const GROUPS: { id: ActionGroup; label: string }[] = [
  { id: "connect", label: "Connect" },
  { id: "diagnostics", label: "Diagnose" },
  { id: "clipboard", label: "Copy" },
];

/**
 * The right-click menu on a device row.
 *
 * Connect first, because that is the point of the tool: scan, right-click,
 * Remote Desktop. Unavailable actions stay listed but disabled and say why in
 * their tooltip, so the menu never changes shape between two devices and a
 * technician learns one layout.
 */
export function ContextMenu({
  anchor,
  host,
  cellColumn,
  selectionCount,
  onAction,
  onClose,
}: {
  anchor: MenuAnchor;
  host: HostResult;
  /** The column that was right-clicked, which Copy cell refers to. */
  cellColumn: ColumnKey | null;
  selectionCount: number;
  onAction: (action: DeviceAction, host: HostResult) => void;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(anchor);

  // Flip the menu back inside the window rather than letting it open off the
  // edge, which is where a right-click on the last row or the last column puts
  // it on a laptop screen.
  useLayoutEffect(() => {
    const el = menu.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    setPosition({
      x: Math.max(margin, Math.min(anchor.x, window.innerWidth - width - margin)),
      y: Math.max(margin, Math.min(anchor.y, window.innerHeight - height - margin)),
    });
  }, [anchor]);

  useEffect(() => {
    menu.current?.focus();
  }, []);

  const actions = deviceActions(host, {
    ...(cellColumn ? { cellColumn } : {}),
    selectionCount,
  });

  return (
    <>
      {/* A transparent catcher, so the first click anywhere closes the menu
          without also landing on whatever is underneath it. */}
      <div className="fixed inset-0 z-40" onMouseDown={onClose} onContextMenu={onClose} />
      <div
        ref={menu}
        role="menu"
        tabIndex={-1}
        aria-label={`Actions for ${host.ip}`}
        className="popover fixed w-[15.5rem] p-1 outline-none"
        style={{ left: position.x, top: position.y }}
      >
        <p className="menu-label mono truncate text-[11px] normal-case tracking-normal text-ink-soft">
          {host.hostname?.trim() || host.ip}
        </p>

        {GROUPS.map((group, groupIndex) => (
          <div key={group.id}>
            {groupIndex > 0 ? <div className="my-1 h-px bg-line" /> : null}
            <p className="menu-label">{group.label}</p>
            {actions
              .filter((action) => action.group === group.id)
              .map((action) => (
                <button
                  key={action.id}
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  disabled={!action.available}
                  title={action.hint}
                  onClick={() => {
                    onAction(action, host);
                    onClose();
                  }}
                >
                  <span className="flex-1 truncate">{action.label}</span>
                  {action.port ? (
                    <span className="mono shrink-0 text-[11px] text-ink-muted">{action.port}</span>
                  ) : null}
                </button>
              ))}
          </div>
        ))}
      </div>
    </>
  );
}
