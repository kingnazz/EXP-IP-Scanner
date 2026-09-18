import { useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { BrandLogo } from "./BrandLogo";
import { Modal } from "../ui/Modal";
import { api } from "../lib/api";
import type { RuntimeInfo } from "../types";
import { APP_VERSION } from "../version";

/**
 * About, and the update check for the installed edition.
 *
 * The portable edition never offers to update itself. That is not a hidden
 * button: a portable build does not link the updater plugin at all, so there
 * is no install-and-relaunch path in the binary to reach. It links to the
 * downloads page instead, which is the honest portable answer.
 */
export function AboutDialog({
  runtime,
  onClose,
  onError,
}: {
  runtime: RuntimeInfo | null;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [updateState, setUpdateState] = useState<
    { kind: "current" } | { kind: "available"; version: string } | null
  >(null);
  const [installing, setInstalling] = useState(false);

  const canSelfUpdate = api.native && runtime?.update_mode === "installer";

  const check = async () => {
    setChecking(true);
    setUpdateState(null);
    try {
      const result = await api.checkForUpdate();
      setUpdateState(
        result.available && result.version
          ? { kind: "available", version: result.version }
          : { kind: "current" },
      );
    } catch (error) {
      onError(
        `Could not check for updates. ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setChecking(false);
    }
  };

  const install = async () => {
    setInstalling(true);
    try {
      await api.installUpdate();
    } catch (error) {
      setInstalling(false);
      onError(
        `Could not install the update. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  return (
    <Modal title="About EXP IP Scanner" onClose={onClose} width="470px">
      {/* The logo at a size that lets the wordmark be read, on the brand's own
          tint rather than a plain panel, because this is the one place in the
          application where the product is being introduced rather than used. */}
      <div
        className="mb-4 flex flex-col items-start gap-2.5 rounded-lg px-4 py-3.5"
        style={{ background: "var(--accent-soft)" }}
      >
        <BrandLogo height={30} />
        <p className="mono text-[12px] text-ink-soft">
          Version {runtime?.version ?? APP_VERSION}
          {runtime ? ` · ${runtime.edition_label}` : null}
          {runtime ? ` · ${runtime.platform} ${runtime.architecture}` : null}
        </p>
      </div>

      <p className="mb-4 text-[12.5px] leading-relaxed text-ink-soft">
        A network scanner for everyday IT work. Scans happen on this computer, results stay in
        memory until you export them, and there is no account, no telemetry and no cloud service
        behind it. The only thing it sends out on its own is the public IP lookup in the network
        summary, which you can turn off in Settings.
      </p>

      <div className="mb-4 rounded-md border border-line px-3 py-2.5">
        {canSelfUpdate ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[12.5px] font-medium">Updates</p>
                <p className="text-[11.5px] text-ink-muted">
                  Checks this project&rsquo;s GitHub releases when you ask it to.
                </p>
              </div>
              <button
                type="button"
                className="btn btn-sm btn-secondary shrink-0"
                onClick={check}
                disabled={checking || installing}
              >
                {checking ? <Loader2 size={12} className="animate-spin" aria-hidden /> : null}
                Check now
              </button>
            </div>
            {updateState?.kind === "current" ? (
              <p className="mt-2 text-[12px] text-ok">This is the latest version.</p>
            ) : null}
            {updateState?.kind === "available" ? (
              <div className="mt-2 flex items-center justify-between gap-3">
                <p className="text-[12px] text-accent-text">
                  Version {updateState.version} is available.
                </p>
                <button
                  type="button"
                  className="btn btn-sm btn-primary shrink-0"
                  onClick={install}
                  disabled={installing}
                >
                  {installing ? <Loader2 size={12} className="animate-spin" aria-hidden /> : null}
                  {installing ? "Installing…" : "Install and restart"}
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <p className="text-[12.5px] font-medium">Updates</p>
            <p className="text-[11.5px] leading-snug text-ink-muted">
              {runtime?.edition === "portable"
                ? "The portable edition never updates itself. Download the next version when you want it."
                : "Update checking is available in the installed edition."}
            </p>
            <button
              type="button"
              className="btn btn-sm btn-secondary mt-2"
              onClick={() => void api.openReleases()}
            >
              <ExternalLink size={12} aria-hidden />
              Open downloads
            </button>
          </>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => void api.openSite()}>
          <ExternalLink size={12} aria-hidden />
          Website
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => void api.openPrivacy()}
        >
          <ExternalLink size={12} aria-hidden />
          Privacy
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => void api.openReleases()}
        >
          <ExternalLink size={12} aria-hidden />
          Releases
        </button>
      </div>
    </Modal>
  );
}
