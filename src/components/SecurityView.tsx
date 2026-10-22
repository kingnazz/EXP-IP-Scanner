import { useMemo, useState } from "react";
import {
  Download,
  Loader2,
  ShieldCheck,
  Square,
  RefreshCw,
} from "lucide-react";
import type {
  AssessmentRun,
  DeviceAssessment,
  Finding,
  Severity,
} from "../security-types";
import type { ScanResult } from "../types";
import { actionable, counts, securityReport } from "../lib/security";
import { api } from "../lib/api";
import { Modal } from "../ui/Modal";
import { DetailRow, SectionTitle } from "../ui/primitives";

export function severityClass(severity: Severity) {
  return severity === "Critical" || severity === "High"
    ? "badge-danger"
    : severity === "Medium"
      ? "badge-warn"
      : "badge-neutral";
}
export function SecurityView({
  source,
  devices,
  run,
  busy,
  error,
  onStop,
  onStart,
  onError,
  focusIp,
}: {
  source: ScanResult | null;
  devices: DeviceAssessment[];
  run: AssessmentRun | null;
  busy: boolean;
  error: string | null;
  onStop: () => void;
  onStart: (deep?: boolean) => Promise<void>;
  onError: (message: string) => void;
  focusIp: string | null;
}) {
  const [selectedIp, setSelectedIp] = useState<string | null>(focusIp);
  const [finding, setFinding] = useState<Finding | null>(null);
  const [confirmDeep, setConfirmDeep] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const totals = useMemo(() => counts(devices), [devices]);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const pageSize = 40;
  const selected = devices.find((d) => d.device_ip === selectedIp);
  const filtered = useMemo(
    () =>
      devices
        .filter((d) =>
          `${d.device_ip} ${d.hostname ?? ""} ${d.services.flatMap((s) => s.technologies.map((t) => t.product)).join(" ")}`
            .toLowerCase()
            .includes(search.toLowerCase()),
        )
        .sort(
          (a, b) =>
            a.score.value - b.score.value ||
            a.device_ip.localeCompare(b.device_ip),
        ),
    [devices, search],
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(
    currentPage * pageSize,
    (currentPage + 1) * pageSize,
  );
  const exportReport = async () => {
    if (!source || !run) return;
    try {
      await api.saveSecurityJson(
        `EXP-security-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(
          securityReport(
            source,
            {
              ...run,
              cancelled: busy || run.cancelled,
              completed_at: busy ? new Date().toISOString() : run.completed_at,
            },
            devices,
          ),
          null,
          2,
        ),
      );
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section
      className="min-h-0 flex-1 overflow-y-auto bg-canvas p-4"
      aria-label="Security assessment"
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <ShieldCheck size={20} className="text-accent-text" />
            Security
          </h1>
          <p className="mt-1 max-w-2xl text-xs text-ink-soft">
            Local, low-impact assessment of discovered services. Scores reflect
            available evidence and coverage.
          </p>
          <p className="mt-1 text-xs text-ink-muted">
            {source
              ? `Target ${source.target} · ${source.hosts.length} discovered devices${source.cancelled ? " · partial discovery" : ""}`
              : "Discover devices to begin automatic Safe Scan."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {busy ? (
            <button className="btn btn-stop" onClick={onStop}>
              <Square size={13} />
              Stop assessment
            </button>
          ) : (
            <button
              className="btn btn-secondary"
              disabled={!source}
              onClick={() => void onStart()}
            >
              <RefreshCw size={13} />
              Safe Scan
            </button>
          )}
          <button
            className="btn btn-secondary"
            disabled={!source || busy}
            onClick={() => {
              setAuthorized(false);
              setConfirmDeep(true);
            }}
          >
            Deep Scan
          </button>
          <button
            className="btn btn-secondary"
            disabled={!run || !devices.length}
            onClick={() => void exportReport()}
          >
            <Download size={13} />
            Export JSON
          </button>
        </div>
      </div>
      {!api.native ? (
        <p className="mb-3 rounded-md border border-line bg-surface p-2 text-xs text-ink-soft">
          Browser demo · illustrative findings only. No network security checks
          run in the browser.
        </p>
      ) : null}
      <div className="mb-4 grid grid-cols-5 gap-2">
        {(
          ["Critical", "High", "Medium", "Low", "Devices Assessed"] as const
        ).map((label) => (
          <div className="panel px-3 py-3" key={label}>
            <p className="text-[11px] font-medium text-ink-soft">{label}</p>
            <p
              className={`mt-1 text-2xl font-semibold ${label === "Critical" || label === "High" ? "text-danger" : ""}`}
            >
              {label === "Devices Assessed" ? devices.length : totals[label]}
            </p>
          </div>
        ))}
      </div>
      <div
        role="status"
        className="mb-3 flex items-center gap-2 text-xs text-ink-soft"
      >
        {busy ? (
          <>
            <Loader2 size={14} className="animate-spin" />
            Analyzing {devices.length} / {source?.hosts.length ?? 0} devices…
            discovery remains available.
          </>
        ) : error ? (
          <span className="text-danger">Assessment unavailable: {error}</span>
        ) : run ? (
          `${run.mode} · ${run.cancelled ? "Stopped or time budget reached · partial results" : "Completed"} · ${new Date(run.started_at).toLocaleString()}`
        ) : source?.cancelled ? (
          "Discovery stopped. Start Safe Scan to assess these partial results."
        ) : (
          "Safe Scan starts automatically after discovery."
        )}
      </div>
      <p className="mb-4 max-w-4xl text-xs text-ink-muted">
        PHP2Shell rules use supplied, unverified CVE identifiers and version
        thresholds. Possible exposure needs vendor review. A score of 100 means
        no deductions from observed evidence; it does not establish that a
        device is secure.
      </p>
      <label className="field-label" htmlFor="security-search">
        Find a device or technology
      </label>
      <input
        id="security-search"
        className="field mb-3 max-w-md"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setPage(0);
        }}
        placeholder="IP, hostname, PHP, Synology…"
      />
      <div className="mb-3 flex items-center gap-2 text-xs text-ink-muted">
        <span>
          {filtered.length} devices · lowest scores first · page{" "}
          {currentPage + 1} of {pageCount}
        </span>
        <button
          className="btn btn-ghost btn-sm"
          disabled={currentPage === 0}
          onClick={() => setPage(currentPage - 1)}
        >
          Previous
        </button>
        <button
          className="btn btn-ghost btn-sm"
          disabled={currentPage + 1 >= pageCount}
          onClick={() => setPage(currentPage + 1)}
        >
          Next
        </button>
      </div>
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1 space-y-2">
          {filtered.length === 0 ? (
            <div className="panel p-6 text-sm text-ink-soft">
              {source
                ? busy
                  ? "Assessments will appear here as devices complete."
                  : "No matching assessed devices."
                : "Run a network scan to assess discovered web services."}
            </div>
          ) : (
            visible.map((device) => {
              const c = counts([device]);
              const products = [
                ...new Set(
                  device.services.flatMap((s) =>
                    s.technologies.map(
                      (t) => `${t.product}${t.version ? ` ${t.version}` : ""}`,
                    ),
                  ),
                ),
              ];
              return (
                <article className="panel p-3" key={device.device_ip}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="truncate text-sm font-semibold">
                        {device.hostname || device.device_ip}
                      </h2>
                      <p className="mono text-xs text-ink-muted">
                        {device.device_ip}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-[10px] text-ink-muted">
                        EXP assessment score
                      </p>
                      <p className="text-xl font-semibold">
                        {device.score.value}
                        <span className="ml-1 text-xs font-normal text-ink-muted">
                          / 100
                        </span>
                      </p>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {(["Critical", "High", "Medium", "Low"] as const)
                      .filter((s) => c[s] > 0)
                      .map((s) => (
                        <span key={s} className={`badge ${severityClass(s)}`}>
                          {c[s]} {s}
                        </span>
                      ))}
                    <span className="text-xs text-ink-muted">
                      {device.complete ? "Assessed" : "Limited coverage"} ·{" "}
                      {device.services.filter((s) => s.status != null).length}{" "}
                      web services
                    </span>
                  </div>
                  <p className="mt-2 break-words text-xs text-ink-soft">
                    {products.join(" · ") ||
                      "No technology identified from available responses"}
                  </p>
                  <button
                    className="btn btn-ghost btn-sm mt-2"
                    onClick={() => setSelectedIp(device.device_ip)}
                    aria-label={`View security details for ${device.device_ip}`}
                  >
                    View Details
                  </button>
                </article>
              );
            })
          )}
        </div>
        {selected ? (
          <div
            className="panel sticky top-0 max-h-[calc(100vh-240px)] w-[22rem] shrink-0 overflow-y-auto p-3"
            aria-label={`Security details for ${selected.device_ip}`}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">{selected.device_ip}</h2>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setSelectedIp(null)}
              >
                Close
              </button>
            </div>
            <SectionTitle>Coverage</SectionTitle>
            <ul className="mb-4 list-disc space-y-1 pl-4 text-xs text-ink-soft">
              {selected.coverage_notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
            <SectionTitle>Score factors</SectionTitle>
            <p className="mb-2 text-xs text-ink-soft">
              100 starting points. Critical −30, High −15, Medium −7, Low −3.
              Expired TLS −8 and admin interface −5 replace severity deductions.
              Each finding counts once.
            </p>
            <ul className="mb-4 text-xs">
              {selected.score.factors.length ? (
                selected.score.factors.map((factor) => (
                  <li
                    className="mb-1 flex justify-between gap-2"
                    key={factor.finding_id}
                  >
                    <span>{factor.title}</span>
                    <span>−{factor.deduction}</span>
                  </li>
                ))
              ) : (
                <li className="text-ink-muted">
                  No deductions from available observations.
                </li>
              )}
            </ul>
            <SectionTitle>Findings</SectionTitle>
            <div className="mb-4 space-y-2">
              {selected.findings.length ? (
                selected.findings.map((f) => (
                  <button
                    key={f.finding_id}
                    className="w-full rounded-md border border-line p-2 text-left hover:bg-surface-hover"
                    onClick={() => setFinding(f)}
                  >
                    <span
                      className={`badge ${actionable(f) ? severityClass(f.severity) : "badge-neutral"}`}
                    >
                      {f.severity}
                    </span>
                    <p className="mt-1 text-xs font-medium">{f.title}</p>
                    <p className="mt-1 text-[11px] text-ink-muted">
                      {(f.exposure_status ?? f.status).replaceAll("_", " ")} ·{" "}
                      {f.port}/{f.protocol}
                    </p>
                  </button>
                ))
              ) : (
                <p className="text-xs text-ink-muted">
                  No findings from available evidence.
                </p>
              )}
            </div>
            <SectionTitle>Web services</SectionTitle>
            {selected.services.map((service) => (
              <div
                className="mb-3 break-words border-b border-line pb-3 text-xs"
                key={service.port}
              >
                <p className="font-medium">{service.endpoint}</p>
                <p className="mt-1 text-ink-soft">
                  {service.status
                    ? `HTTP ${service.status}`
                    : "No HTTP response"}
                  {service.title ? ` · ${service.title}` : ""}
                </p>
                {service.server ? (
                  <p className="mt-1">Server: {service.server}</p>
                ) : null}
                {service.redirect_destination ? (
                  <p className="mt-1">
                    Redirect: {service.redirect_destination} (not followed)
                  </p>
                ) : null}
                {service.technologies.map((tech) => (
                  <div className="mt-2" key={tech.product}>
                    <p>
                      {tech.product} {tech.version} · {tech.confidence}{" "}
                      confidence
                    </p>
                    <ul className="list-disc pl-4 text-ink-muted">
                      {tech.evidence.map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  </div>
                ))}
                {service.tls ? (
                  <dl className="mt-2 text-ink-soft">
                    <dt className="font-medium">TLS certificate</dt>
                    <dd>
                      Trust:{" "}
                      {service.tls.trusted ? "Validated" : "Not verified"}
                    </dd>
                    <dd>
                      Subject: {service.tls.certificate_subject ?? "Unknown"}
                    </dd>
                    <dd>
                      Issuer: {service.tls.certificate_issuer ?? "Unknown"}
                    </dd>
                    <dd>Expires: {service.tls.expires_at ?? "Unknown"}</dd>
                    <dd>
                      IP mismatch:{" "}
                      {service.tls.hostname_mismatch == null
                        ? "Unknown"
                        : service.tls.hostname_mismatch
                          ? "Yes"
                          : "No"}
                    </dd>
                    <dd>
                      Self-signed indication:{" "}
                      {service.tls.self_signed_indication == null
                        ? "Unknown"
                        : service.tls.self_signed_indication
                          ? "Yes"
                          : "No"}
                    </dd>
                    <dd>TLS protocol sweep: not performed</dd>
                    {service.tls.error ? <dd>{service.tls.error}</dd> : null}
                  </dl>
                ) : (
                  <p className="mt-2 text-ink-muted">
                    Unencrypted HTTP response
                  </p>
                )}
                {service.error ? (
                  <p className="mt-2 text-warn">{service.error}</p>
                ) : null}
                {service.body_truncated ? (
                  <p className="text-warn">Body inspection capped at 64 KiB.</p>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {finding ? (
        <Modal
          title={finding.title}
          onClose={() => setFinding(null)}
          description="Evidence-based assessment · verify vendor guidance"
          width="660px"
        >
          <span className={`badge ${severityClass(finding.severity)}`}>
            {finding.severity}
          </span>
          <dl className="my-3">
            <DetailRow label="Status">
              {(finding.exposure_status ?? finding.status).replaceAll("_", " ")}
            </DetailRow>
            <DetailRow label="Affected IP">{finding.device_ip}</DetailRow>
            <DetailRow label="Port">
              {finding.port} / {finding.protocol}
            </DetailRow>
            <DetailRow label="Product">{finding.product}</DetailRow>
            <DetailRow label="Version">
              {finding.detected_version ?? "Unknown"}
            </DetailRow>
            <DetailRow label="CVEs">
              {finding.cve_ids.join(" / ") || "None"}
            </DetailRow>
            <DetailRow label="Confidence">{finding.confidence}</DetailRow>
          </dl>
          <SectionTitle>Evidence</SectionTitle>
          <ul className="mb-4 list-disc space-y-1 pl-4 text-sm">
            {finding.evidence.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
          <SectionTitle>Description</SectionTitle>
          <p className="mb-4 text-sm text-ink-soft">{finding.description}</p>
          <SectionTitle>Remediation</SectionTitle>
          <p className="mb-4 text-sm">{finding.remediation}</p>
          {finding.references.length ? (
            <>
              <SectionTitle>References</SectionTitle>
              <ul className="space-y-1 break-all text-xs text-ink-muted">
                {finding.references.map((ref) => (
                  <li key={ref}>{ref}</li>
                ))}
              </ul>
            </>
          ) : null}
        </Modal>
      ) : null}
      {confirmDeep ? (
        <Modal
          title="Deep Scan"
          description="Only scan systems you own or are authorized to test."
          onClose={() => setConfirmDeep(false)}
          footer={
            <>
              <button
                className="btn btn-secondary"
                onClick={() => setConfirmDeep(false)}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={!authorized}
                onClick={() => {
                  setConfirmDeep(false);
                  void onStart(true);
                }}
              >
                Start low-impact verification
              </button>
            </>
          }
        >
          <p className="mb-4 text-sm text-ink-soft">
            Deep Scan currently repeats the same low-impact HTTP and TLS checks.
            No exploit, login attempt or intrusive validation is implemented.
            Safe Scan never escalates automatically.
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={authorized}
              onChange={(e) => setAuthorized(e.target.checked)}
              className="mt-1"
            />
            I own these systems or am authorized to test them.
          </label>
        </Modal>
      ) : null}
    </section>
  );
}
