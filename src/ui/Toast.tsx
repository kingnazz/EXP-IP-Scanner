import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Info, X } from "lucide-react";

export type ToastKind = "info" | "success" | "error";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

/** How long a message stays before it disappears on its own. */
const DISMISS_MS: Record<ToastKind, number> = {
  // An error stays longer, because it usually says something the technician
  // has to act on.
  error: 8_000,
  info: 4_500,
  success: 3_000,
};

let nextId = 1;

/**
 * Transient messages.
 *
 * Deliberately not modal and deliberately not a completion dialog: a scan
 * finishing must never interrupt someone mid-click. Only things that went
 * wrong, or that happened out of sight, get a message at all.
 */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = nextId++;
    setToasts((current) => {
      // At most three at once; the oldest goes rather than growing a stack that
      // covers the table.
      const next = [...current, { id, kind, message }];
      return next.slice(-3);
    });
    return id;
  }, []);

  const error = useCallback((message: string) => push("error", message), [push]);
  const info = useCallback((message: string) => push("info", message), [push]);
  const success = useCallback((message: string) => push("success", message), [push]);

  return { toasts, push, error, info, success, dismiss };
}

const ICONS = { info: Info, success: Check, error: AlertTriangle };

const TONE: Record<ToastKind, string> = {
  info: "text-accent-text",
  success: "text-ok",
  error: "text-danger",
};

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const Icon = ICONS[toast.kind];

  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), DISMISS_MS[toast.kind]);
    return () => clearTimeout(timer);
  }, [toast.id, toast.kind, onDismiss]);

  return (
    <div className="animate-slide-in-right panel pointer-events-auto flex items-start gap-2.5 px-3 py-2.5">
      <Icon size={15} className={`mt-px shrink-0 ${TONE[toast.kind]}`} aria-hidden />
      <p className="min-w-0 flex-1 text-[12.5px] leading-snug">{toast.message}</p>
      <button
        type="button"
        className="icon-btn icon-btn-sm -mr-1 -mt-1"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss"
      >
        <X size={13} />
      </button>
    </div>
  );
}
