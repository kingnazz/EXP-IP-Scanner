import { useMemo, useState } from "react";
import { Globe2, Loader2, ShieldAlert, ShieldCheck } from "lucide-react";
import { websiteSecurityAssessment } from "../lib/websiteSecurity";
import type { SecurityAssessment } from "../types";
import { Modal } from "../ui/Modal";

function statusStyle(status: SecurityAssessment["status"]) {
  switch (status) {
    case "critical":
      return { label: "Critical", className: "text-danger", icon: ShieldAlert };
    case "attention":
      return { label: "Needs review", className: "text-warn", icon: ShieldAlert };
    case "clear":
      return { label: "No exposed affected version", className: "text-ok", icon: ShieldCheck };
    default:
      return { label: "Unknown", className: "text-ink-muted", icon: ShieldAlert };
  }
}

export function WebsiteCheckDialog({ onClose }: { onClose: () => void }) {
  const [target, setTarget] = useState("");
  const [checking, setChecking] = useState(false);
  const [assessment, setAssessment] = useState<SecurityAssessment | null>(null);
  const [error, setError] = useState<string | null>(null);

  const phpVersions = useMemo(
    () =>
      Array.from(
        new Set(
          (assessment?.web_services ?? [])
            .map((service) => service.php_version)
            .filter((value): value is string => Boolean(value)),
        ),
      ),
    [assessment],
  );

  const phpDetected = Boolean(
    assessment?.web_services.some(
      (service) =>
        service.php_version ||
        service.powered_by?.toLowerCase().includes("php") ||
        ["PHP web application", "WordPress", "phpMyAdmin"].includes(service.product ?? ""),
    ),
  );

  const run = async () => {
    const value = target.trim();
    if (!value || checking) return;
    setChecking(true);
    setAssessment(null);
    setError(null);
    try {
      setAssessment(await websiteSecurityAssessment(value));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setChecking(false);
    }
  };

  const visual = assessment ? statusStyle(assessment.status) : null;
  const StatusIcon = visual?.icon ?? ShieldCheck;

  return (
    <Modal title="Website Security Check" onClose={onClose} width="620px">
      <div className="mb-4 rounded-lg border border-line bg-surface-raised p-3">
        <div className="mb-2 flex items-center gap-2">
          <Globe2 size={15} className="text-accent-text" aria-hidden />
          <div>
            <p className="text-[12.5px] font-medium">Check a website for PHP2Shell and critical web-product CVEs</p>
            <p className="text-[11.5px] text-ink-muted">
              Passive HTTP/HTTPS fingerprint only. No exploit payloads are sent.
            </p>
          </div>
        </div>

        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          <label className="sr-only" htmlFor="website-security-target">
            Website URL
          </label>
          <input
            id="website-security-target"
            className="field field-lg min-w-0 flex-1 mono"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            placeholder="example.com or https://portal.example.com"
            spellCheck={false}
            autoComplete="off"
            disabled={checking}
            autoFocus
          />
          <button
            type="submit"
            className="btn btn-lg btn-primary min-w-[7.5rem]"
            disabled={checking || target.trim().length === 0}
          >
            {checking ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <ShieldCheck size={13} aria-hidden />}
            {checking ? "Checking…" : "Check"}
          </button>
        </form>
      </div>

      {checking ? (
        <div className="flex items-center gap-2 rounded-md border border-line px-3 py-3 text-[12px] text-ink-soft">
          <Loader2 size={14} className="animate-spin" aria-hidden />
          Reading ordinary website response headers and metadata…
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2.5 text-[12px] text-danger">
          {error}
        </div>
      ) : null}

      {assessment && visual ? (
        <div className="space-y-3">
          <div className="rounded-lg border border-line p-3">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="mono truncate text-[12px] text-ink-muted" title={assessment.target}>
                  {assessment.target}
                </p>
                <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">{assessment.summary}</p>
              </div>
              <div className={`flex shrink-0 items-center gap-1.5 text-[12px] font-semibold ${visual.className}`}>
                <StatusIcon size={14} aria-hidden />
                {visual.label}
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="rounded-md bg-surface-raised px-3 py-2">
                <p className="text-[10.5px] uppercase tracking-wide text-ink-muted">PHP</p>
                <p className="mt-0.5 text-[12.5px] font-medium">
                  {phpVersions.length > 0
                    ? `PHP ${phpVersions.join(", ")}`
                    : phpDetected
                      ? "Detected, version hidden"
                      : "Not identified"}
                </p>
              </div>
              <div className="rounded-md bg-surface-raised px-3 py-2">
                <p className="text-[10.5px] uppercase tracking-wide text-ink-muted">Web response</p>
                <p className="mt-0.5 text-[12.5px] font-medium">
                  {assessment.web_services
                    .filter((service) => service.status != null)
                    .map((service) => `${service.scheme.toUpperCase()} ${service.status}`)
                    .join(" · ") || "No readable response"}
                </p>
              </div>
            </div>
          </div>

          {assessment.findings.length > 0 ? (
            <div className="space-y-2">
              {assessment.findings.map((finding) => (
                <div key={finding.id} className="rounded-md border border-line px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[12.5px] font-semibold">{finding.title}</p>
                    <span
                      className={`text-[10.5px] font-semibold uppercase tracking-wide ${
                        finding.severity === "critical"
                          ? "text-danger"
                          : finding.severity === "high"
                            ? "text-warn"
                            : "text-ink-muted"
                      }`}
                    >
                      {finding.severity}
                    </span>
                  </div>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-ink-soft">{finding.summary}</p>
                  {finding.cves.length > 0 ? (
                    <p className="mono mt-1.5 text-[10.5px] text-ink-muted">{finding.cves.join(" · ")}</p>
                  ) : null}
                  <div className="mt-2 rounded bg-surface-raised px-2.5 py-2 text-[11px] leading-relaxed text-ink-muted">
                    <span className="font-medium text-ink-soft">Evidence: </span>
                    {finding.evidence}
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-ink-muted">
                    <span className="font-medium text-ink-soft">Recommended: </span>
                    {finding.remediation}
                  </p>
                </div>
              ))}
            </div>
          ) : null}

          <p className="text-[10.5px] leading-relaxed text-ink-muted">
            A clear passive result means the checked page did not expose a version affected by the security rules EXP IP Scanner currently knows. Hidden or backend components may still require direct verification.
          </p>
        </div>
      ) : null}
    </Modal>
  );
}
