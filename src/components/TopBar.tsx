import { CircleAlert, Info, Monitor, Moon, Settings, Sun } from "lucide-react";
import type { ThemePref } from "../lib/prefs";
import { BrandLogo } from "./BrandLogo";

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
 * The logo is the heading: the wordmark already says "EXP IP Scanner", so
 * setting the name in type beside it would only say it twice. The `<svg>`
 * carries the name as its accessible label, which is what the `<h1>` is named
 * from, so a screen reader still reads a heading here.
 *
 * There is no navigation, because there is nowhere to navigate to: everything
 * a technician needs is on the one screen below. The only controls here are
 * the ones that are not part of scanning.
 */
export function TopBar({
  theme,
  onThemeChange,
  onOpenSettings,
  onOpenAbout,
  updateVersion,
  version,
  edition,
}: {
  theme: ThemePref;
  onThemeChange: (next: ThemePref) => void;
  onOpenSettings: () => void;
  onOpenAbout: () => void;
  updateVersion: string | null;
  version: string;
  edition: string | null;
}) {
  const ThemeIcon = THEME_ICON[theme];
  const nextTheme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length] ?? "system";

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <h1 className="flex shrink-0 items-center">
          <BrandLogo height={20} />
        </h1>
        <span className="mono shrink-0 text-[11px] text-ink-muted">v{version}</span>
        {edition ? (
          <span className="badge badge-neutral shrink-0" title="Which edition is running">
            {edition}
          </span>
        ) : null}
      </div>

      <div className="flex-1" />

      {updateVersion ? (
        <button
          type="button"
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-red-500/35 bg-red-500/10 px-2 text-[11.5px] font-medium text-red-600 transition-colors hover:bg-red-500/15 dark:text-red-400"
          onClick={onOpenAbout}
          title={`Version ${updateVersion} is available. Open update controls.`}
          aria-label={`Update available: version ${updateVersion}`}
        >
          <CircleAlert size={13} aria-hidden />
          Update v{updateVersion}
        </button>
      ) : null}

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
