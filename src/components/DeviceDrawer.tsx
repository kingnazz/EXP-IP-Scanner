import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck, X } from "lucide-react";
import { deviceActions, primaryAction, type DeviceAction } from "../lib/actions";
import { api } from "../lib/api";
import { formatLatency, formatTime, isActionablePort, serviceName } from "../lib/format";
import type { DeviceRow } from "../lib/live";
import type { LocalNetwork, PingOutcome, SecurityAssessment } from "../types";
import { DetailRow, NoValue, SectionTitle } from "../ui/primitives";

const WEB_SECURITY_PORTS = new Set([80, 443, 5000, 5001, 8000, 8008, 8080, 8443, 8888]);

/**
 * The device details panel.
 *
 * A drawer over the right-hand side rather than a page, because leaving the
 * results to look at one device would lose the consultant's place in a scan
 * that may still be running. The scan keeps going and the table keeps
 * updating behind it.
 */
export function DeviceDrawer({
  row,
  network,
  onClose,
  onAction,
  pingResult,
  pinging,
  watchActive = false,
  securityAssessment = null,
  onSecurityAssessment,
}: {
  row: DeviceRow;
  /** The interface the scan ran from, for the network context section. */
  network: LocalNetwork | null;
  onClose: () => void;
  onAction: (action: DeviceAction) => void;
  pingResult: PingOutcome | null;
  pinging: boolean;
  watchActive?: boolean;
  /** Cached result from a network-wide security pass, when one exists. */
  securityAssessment?: SecurityAssessment | null;
  onSecurityAssessment?: (assessment: SecurityAssessment) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const { host } = row;
  const actions = deviceActions(host);
  const primary = primaryAction(host);
  const connect = actions.filter((a) => a.group === "connect");
  const diagnostics = actions.filter((a) => a.group === "diagnostics");
  const hasWebPort = host.open_ports.some((port) => WEB_SECURITY_PORTS.has(port));
  const [localSecurity, setLocalSecurity] = useState<SecurityAssessment | null>(null);
  const [securityLoading, setSecurityLoading] = useState(false);
  const [securityError, setSecurityError] = useState<string | null>(null);
  const security = securityAssessment ?? localSecurity;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    setLocalSecurity(null);
    setSecurityError(null);
    setSecurityLoading(false);
  }, [host.ip]);

  const runSecurityCheck = async () => {
    if (securityLoading || !hasWebPort || row.watchState === "offline") return;
    setSecurityLoading(true);
    setSecurityError(null);
    try {
      const assessment = await api.securityAssessment(host.ip, host.open_ports);
      setLocalSecurity(assessment);
      onSecurityAssessment?.(assessment);
    } catch (error) {
      setSecurityError(error instanceof Error ? error.message : String(error));
    } finally {
      setSecurityLoading(false);
    }
  };

  return (
    <aside
      ref={panel}
      className="animate-slide-in-right flex w-[21rem] shrink-0 flex-col border-l border-line bg-surface-raised"
      aria-label={`Details for ${host.ip}`}
    >
      <header className="flex items-start gap-2 border-b border-line px-3.5 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[13.5px] font-semibold leading-tight">
            {host.hostname?.trim() || host.ip}
          </h2>
          <p className="mono mt-0.5 truncate text-[12px] text-ink-muted">{host.ip}</p>
        </div>
        {host.is_self ? <span className="badge badge-accent mt-0.5">This PC</span> : null}
        {row.watchState === "new" ? (
          <span className="badge badge-ok mt-0.5">New</span>
        ) : row.watchState === "changed" ? (
          <span className="badge badge-warn mt-0.5">Changed</span>
        ) : row.watchState === "offline" ? (
          <span className="badge badge-danger mt-0.5">Offline</span>
        ) : watchActive ? (
          <span className="badge badge-ok mt-0.5">Online</span>
        ) : null}
        <button type="button" className="icon-btn icon-btn-sm -mr-1" onClick={onClose} aria-label="Close details">
          <X size={14} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        {primary && row.watchState !== "offline" ? (
          <button
            type="button"
            className="btn btn-primary mb-3 w-full"
            onClick={() => onAction(primary)}
            title={primary.hint}
          >
            {primary.label}
          </button>
        ) : null}

        <dl className="mb-4">
          <DetailRow label="IP address" mono>
            {host.ip}
          </DetailRow>
          <DetailRow label="Hostname">
            {host.hostname?.trim() ?? <NoValue title="No reverse DNS record for this address" />}
          </DetailRow>
          <DetailRow label="MAC address" mono>
            {host.mac?.trim() ?? (
              <NoValue title="Only visible for devices on your own network segment" />
            )}
          </DetailRow>
          <DetailRow label="Manufacturer">
            {host.vendor?.trim() ?? <NoValue title="No manufacturer registered for this MAC prefix" />}
          </DetailRow>
          <DetailRow label="Latency">
            {row.watchState === "offline" ? (
              <span className="font-medium text-danger">Offline</span>
            ) : (
              formatLatency(host.latency_ms) ?? (
                <NoValue title="This device answered no ping and no TCP probe" />
              )
            )}
          </DetailRow>
          {host.icmp_ms != null || host.tcp_ms != null ? (
            <DetailRow label="Measured">
              <span className="text-[12px] text-ink-soft">
                {host.icmp_ms != null ? `ping ${formatLatency(host.icmp_ms)}` : null}
                {host.icmp_ms != null && host.tcp_ms != null ? " · " : null}
                {host.tcp_ms != null ? `TCP ${formatLatency(host.tcp_ms)}` : null}
              </span>
            </DetailRow>
          ) : null}
          <DetailRow label="TTL">
            {host.ttl != null ? host.ttl : <NoValue title="No ICMP reply to read a TTL from" />}
          </DetailRow>
          <DetailRow label="Device type">
            {host.os_hint ? (
              <span>
                {host.os_hint}{" "}
                <span
                  className="text-[11.5px] text-ink-muted"
                  title="Derived from the reply TTL. A hint, not a reliable identification."
                >
                  (estimated)
                </span>
              </span>
            ) : (
              <NoValue title="Not enough information to estimate" />
            )}
          </DetailRow>
          <DetailRow label={watchActive ? "Last seen" : "Found at"}>{formatTime(host.seen_at)}</DetailRow>
        </dl>

        <section className="mb-4">
          <SectionTitle>Open ports</SectionTitle>
          {host.open_ports.length === 0 ? (
            <p className="text-[12.5px] text-ink-muted">
              No open ports among the ports scanned. This device was found on the network but
              answered nothing, which is normal for printers, cameras and hardened workstations.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {host.open_ports.map((port) => (
                <li
                  key={port}
                  className="flex items-baseline gap-2 rounded-sm px-1.5 py-1"
                  style={
                    isActionablePort(port) ? { background: "var(--accent-soft)" } : undefined
                  }
                >
                  <span className="mono w-11 shrink-0 text-[12px] font-semibold">{port}</span>
                  <span className="text-[12.5px]">
                    {serviceName(port) ?? (
                      <span className="text-ink-muted">Unrecognised service</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mb-4">
          <SectionTitle>Security</SectionTitle>
          <button
            type="button"
            className="btn btn-sm btn-secondary w-full justify-center"
            disabled={!hasWebPort || securityLoading || row.watchState === "offline"}
            onClick={() => void runSecurityCheck()}
            title={
              hasWebPort
                ? "Passive HTTP/HTTPS fingerprinting only. No exploit payloads are sent."
                : "No supported web port was found in this scan."
            }
          >
            {securityLoading ? (
              <Loader2 size={13} className="animate-spin" aria-hidden />
            ) : (
              <ShieldCheck size={13} aria-hidden />
            )}
            {securityLoading
              ? "Checking web exposure…"
              : hasWebPort
                ? security
                  ? "Run security check again"
                  : "Check web exposure"
                : "No web services found"}
          </button>
          <p className="mt-1.5 text-[11px] leading-snug text-ink-muted">
            Safe scan: fingerprints HTTP/HTTPS, PHP patch level, Synology DSM critical patch status
            and Synology PHP package exposure. It does not attempt exploitation.
          </p>

          {securityError ? (
            <div className="mt-2 rounded-sm border border-danger/30 bg-danger/5 px-2 py-1.5 text-[11.5px] text-danger" role="alert">
              {securityError}
            </div>
          ) : null}

          {security ? (
            <div className="mt-2.5" aria-live="polite">
              <div className="rounded-sm border border-line bg-surface px-2.5 py-2">
                <div className="flex items-center gap-2">
                  {security.status === "critical" || security.status === "attention" ? (
                    <AlertTriangle size={14} className={security.status === "critical" ? "text-danger" : "text-warn"} aria-hidden />
                  ) : (
                    <CheckCircle2 size={14} className="text-ok" aria-hidden />
                  )}
                  <span className={`badge ${securityBadgeClass(security.status)}`}>
                    {securityStatusLabel(security.status)}
                  </span>
                </div>
                <p className="mt-1.5 text-[11.5px] leading-snug text-ink-soft">{security.summary}</p>
              </div>

              {security.web_services.length > 0 ? (
                <div className="mt-2">
                  <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-ink-muted">Web services</p>
                  <div className="flex flex-col gap-1">
                    {security.web_services.map((service) => (
                      <div key={`${service.scheme}-${service.port}`} className="rounded-sm bg-surface-sunken px-2 py-1.5 text-[11.5px]">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-ink">
                            {service.product ?? `${service.scheme.toUpperCase()} service`}
                          </span>
                          <span className="mono text-ink-muted">:{service.port}</span>
                        </div>
                        <p className="mt-0.5 text-ink-muted">
                          {service.php_version ? `PHP ${service.php_version}` : service.server ?? service.note ?? "Responded"}
                          {service.status != null ? ` · HTTP ${service.status}` : ""}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {security.findings.length > 0 ? (
                <div className="mt-2 flex flex-col gap-1.5">
                  {security.findings.map((finding) => (
                    <div key={finding.id} className="rounded-sm border border-line px-2 py-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-[11.5px] font-semibold leading-snug text-ink">{finding.title}</p>
                        <span className={`badge shrink-0 ${findingSeverityClass(finding.severity)}`}>
                          {finding.severity}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] leading-snug text-ink-soft">{finding.summary}</p>
                      {finding.cves.length > 0 ? (
                        <p className="mono mt-1 text-[10.5px] text-ink-muted">{finding.cves.join(" · ")}</p>
                      ) : null}
                      <p className="mt-1 text-[10.5px] leading-snug text-ink-muted">
                        Fix: {finding.remediation}
                      </p>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </section>

        <section className="mb-4">
          <SectionTitle>Connect</SectionTitle>
          <div className="grid grid-cols-2 gap-1.5">
            {connect.map((action) => (
              <button
                key={action.id}
                type="button"
                className="btn btn-sm btn-secondary justify-start"
                disabled={row.watchState === "offline" || !action.available}
                title={action.hint}
                onClick={() => onAction(action)}
              >
                <span className="truncate">{shortLabel(action.label)}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="mb-4">
          <SectionTitle>Diagnose</SectionTitle>
          <div className="flex flex-wrap gap-1.5">
            {diagnostics.map((action) => (
              <button
                key={action.id}
                type="button"
                className="btn btn-sm btn-secondary"
                title={action.hint}
                onClick={() => onAction(action)}
              >
                {action.id === "ping" && pinging ? (
                  <Loader2 size={12} className="animate-spin" aria-hidden />
                ) : null}
                {shortLabel(action.label)}
              </button>
            ))}
          </div>
          {pingResult ? (
            <p
              className={`mono mt-2 rounded-sm px-2 py-1.5 text-[11.5px] leading-snug ${
                pingResult.replied ? "text-ok" : "text-warn"
              }`}
              style={{ background: "var(--color-surface-sunken)" }}
              role="status"
            >
              {pingResult.summary}
            </p>
          ) : null}
        </section>

        <section>
          <SectionTitle>Network</SectionTitle>
          {network ? (
            <p className="text-[12.5px] leading-relaxed text-ink-soft">
              Scanned from <span className="font-medium text-ink">{network.interface}</span> at{" "}
              <span className="mono">{network.ip}</span>
              <span className="text-ink-muted"> /{network.prefix}</span>
              <br />
              <span className="text-ink-muted">
                {network.kind_label} adapter · {network.cidr}
              </span>
            </p>
          ) : (
            <p className="text-[12.5px] text-ink-muted">No adapter information available.</p>
          )}
        </section>
      </div>
    </aside>
  );
}

function securityStatusLabel(status: SecurityAssessment["status"]): string {
  if (status === "critical") return "Critical";
  if (status === "attention") return "Needs review";
  if (status === "clear") return "No issue found";
  return "Unknown";
}

function securityBadgeClass(status: SecurityAssessment["status"]): string {
  if (status === "critical") return "badge-danger";
  if (status === "attention") return "badge-warn";
  if (status === "clear") return "badge-ok";
  return "";
}

function findingSeverityClass(severity: string): string {
  if (severity === "critical") return "badge-danger";
  if (severity === "high" || severity === "medium") return "badge-warn";
  if (severity === "info") return "badge-accent";
  return "";
}

/** Button labels in the drawer drop the leading verb, which the heading says. */
function shortLabel(label: string): string {
  return label.replace(/^Open /, "").replace(/^Copy /, "Copy ");
}
