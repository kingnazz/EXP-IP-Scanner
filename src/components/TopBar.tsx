import { Info, Monitor, Moon, Settings, Sun } from "lucide-react";
import type { ThemePref } from "../lib/prefs";

const THEME_ORDER: ThemePref[] = ["system", "light", "dark"];
const THEME_ICON = { system: Monitor, light: Sun, dark: Moon };
const THEME_LABEL: Record<ThemePref, string> = {
  system: "Theme: following Windows",
  light: "Theme: light",
  dark: "Theme: dark",
};

/**
 * The title bar.
 *
 * Branding stays restrained and there is no navigation, because there is
 * nowhere to navigate to: everything a technician needs is on the one screen
 * below. The only controls here are the ones that are not part of scanning.
 */
export function TopBar({
  theme,
  onThemeChange,
  onOpenSettings,
  onOpenAbout,
  version,
  edition,
}: {
  theme: ThemePref;
  onThemeChange: (next: ThemePref) => void;
  onOpenSettings: () => void;
  onOpenAbout: () => void;
  version: string;
  edition: string | null;
}) {
  const ThemeIcon = THEME_ICON[theme];
  const nextTheme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length] ?? "system";

  return (
    <header className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
      <div className="flex min-w-0 items-center gap-2">
        <ScanMark />
        <h1 className="truncate text-[13.5px] font-semibold tracking-[-0.01em]">
          EXP IP Scanner
        </h1>
        <span className="mono shrink-0 text-[11px] text-ink-muted">v{version}</span>
        {edition ? (
          <span className="badge badge-neutral shrink-0" title="Which edition is running">
            {edition}
          </span>
        ) : null}
      </div>

      <div className="flex-1" />

      <button
        type="button"
        className="icon-btn"
        onClick={() => onThemeChange(nextTheme)}
        title={THEME_LABEL[theme]}
        aria-label={THEME_LABEL[theme]}
      >
        <ThemeIcon size={15} />
      </button>
      <button
        type="button"
        className="icon-btn"
        onClick={onOpenSettings}
        title="Settings"
        aria-label="Settings"
      >
        <Settings size={15} />
      </button>
      <button
        type="button"
        className="icon-btn"
        onClick={onOpenAbout}
        title="About EXP IP Scanner"
        aria-label="About EXP IP Scanner"
      >
        <Info size={15} />
      </button>
    </header>
  );
}

/** The application mark: the same scan sweep as the executable's icon. */
function ScanMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden className="shrink-0">
      <circle cx="5.5" cy="18.5" r="2.4" fill="var(--color-accent)" />
      <path
        d="M5.5 12.6a5.9 5.9 0 0 1 5.9 5.9"
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <path
        d="M5.5 7.4a11.1 11.1 0 0 1 11.1 11.1"
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <path
        d="M5.5 2.5A16 16 0 0 1 21.5 18.5"
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="1.7"
        strokeLinecap="round"
        opacity="0.5"
      />
    </svg>
  );
}
