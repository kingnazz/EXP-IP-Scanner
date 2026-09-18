// Small building blocks used across the interface.
//
// Presentational only. Anything that needs to make a decision lives in `lib/`
// where it can be tested without a renderer.

import type { ReactNode } from "react";

/** A label/value pair in the details panel. */
export function DetailRow({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[104px_1fr] items-baseline gap-3 py-[5px]">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className={`min-w-0 break-words text-[13px] ${mono ? "mono" : ""}`}>{children}</dd>
    </div>
  );
}

/** The em dash that means "no value", so a blank cell always means a bug. */
export function NoValue({ title }: { title?: string }) {
  return (
    <span className="no-value" title={title}>
      —
    </span>
  );
}

/** A section heading inside a panel or dialog. */
export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
      {children}
    </h3>
  );
}

/** A checkbox with its label, used in Settings and the column menu. */
export function CheckboxRow({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-2.5 py-1.5 ${
        disabled ? "cursor-not-allowed opacity-50" : ""
      }`}
    >
      <input
        type="checkbox"
        className="mt-0.5 size-3.5 shrink-0 rounded-[3px] accent-[var(--color-accent)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-[13px] leading-tight">{label}</span>
        {hint ? (
          <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-muted">{hint}</span>
        ) : null}
      </span>
    </label>
  );
}

/** A numeric setting with its unit and range. */
export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  hint,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  hint?: string;
}) {
  return (
    <div>
      <label className="field-label">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="number"
          className="field w-28"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const next = Number.parseInt(e.target.value, 10);
            if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)));
          }}
        />
        {unit ? <span className="text-[12px] text-ink-muted">{unit}</span> : null}
      </div>
      {hint ? <p className="mt-1 text-[11.5px] leading-snug text-ink-muted">{hint}</p> : null}
    </div>
  );
}
