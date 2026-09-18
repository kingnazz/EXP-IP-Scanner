import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A centred dialog.
 *
 * Focus moves into the dialog on open and the Escape key closes it, because a
 * dialog a keyboard user cannot reach or leave is not a dialog. Focus is kept
 * inside while it is open, so Tab cannot land on the table behind it.
 */
export function Modal({
  title,
  description,
  onClose,
  children,
  footer,
  width = "560px",
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panel.current) return;
      const focusable = panel.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      previous?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{ width, maxWidth: "100%" }}
        className="panel flex max-h-full flex-col overflow-hidden outline-none"
      >
        <header className="flex items-start gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold leading-tight">{title}</h2>
            {description ? (
              <p className="mt-1 text-[12px] leading-snug text-ink-muted">{description}</p>
            ) : null}
          </div>
          <button type="button" className="icon-btn icon-btn-sm" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>

        {footer ? (
          <footer className="flex items-center justify-end gap-2 border-t border-line bg-surface-raised px-4 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}
