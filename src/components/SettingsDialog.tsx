import { useMemo } from "react";
import { RotateCcw } from "lucide-react";
import { Modal } from "../ui/Modal";
import { CheckboxRow, NumberField, SectionTitle } from "../ui/primitives";
import { parsePorts } from "../lib/format";
import type { Settings } from "../lib/prefs";
import { PUBLIC_IP_SERVICES } from "../lib/publicip";

/**
 * Settings.
 *
 * Deliberately one short screen. The defaults are chosen so most technicians
 * never open this at all, and every field here earns its place by being
 * something a real network occasionally needs changed -- a slow link that
 * wants a longer timeout, a fragile switch that wants less fan-out, a site
 * where reverse DNS is broken and only slows the scan down.
 *
 * Restore defaults is always available, because a tool people are afraid to
 * experiment with is a tool they stop exploring.
 */
export function SettingsDialog({
  settings,
  defaultPorts,
  onChange,
  onRestoreDefaults,
  onClose,
}: {
  settings: Settings;
  /** The backend's default technician port set, shown when the field is empty. */
  defaultPorts: number[];
  onChange: (patch: Partial<Settings>) => void;
  onRestoreDefaults: () => void;
  onClose: () => void;
}) {
  const portState = useMemo(() => parsePorts(settings.portSpec), [settings.portSpec]);
  const effectivePortCount =
    settings.portSpec.trim().length === 0 ? defaultPorts.length : portState.ports.length;

  return (
    <Modal
      title="Settings"
      description="Defaults suit most networks. Everything here is optional."
      onClose={onClose}
      width="580px"
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onRestoreDefaults}>
            <RotateCcw size={13} aria-hidden />
            Restore defaults
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <section className="mb-5">
        <SectionTitle>Scan</SectionTitle>
        <CheckboxRow
          checked={settings.scanServices}
          onChange={(scanServices) => onChange({ scanServices })}
          label="Detect open services"
          hint="Probes the ports below so the table shows what each device runs. Off still probes a few common ports, so devices that ignore ping are not missed."
        />
        <CheckboxRow
          checked={settings.resolveHostnames}
          onChange={(resolveHostnames) => onChange({ resolveHostnames })}
          label="Look up hostnames"
          hint="Reverse DNS, run alongside the scan. Worth turning off only where DNS is broken or very slow."
        />
      </section>

      <section className="mb-5">
        <SectionTitle>Network summary</SectionTitle>
        <CheckboxRow
          checked={settings.lookupPublicIp}
          onChange={(lookupPublicIp) => onChange({ lookupPublicIp })}
          label="Look up this network's public IP address"
          hint={`The only request this application makes on its own. It asks ${PUBLIC_IP_SERVICES.map(
            (service) => service.host,
          ).join(
            " or ",
          )} what address this network appears as from outside. It sends no scan results, discovered-device data or application identifier; like any HTTPS request, the lookup service can see the public IP making the request. Turning it off leaves the rest of the summary working.`}
        />
      </section>

      <section className="mb-5">
        <SectionTitle>Ports</SectionTitle>
        <label className="field-label" htmlFor="port-spec">
          Ports to probe
        </label>
        <input
          id="port-spec"
          className={`field mono ${portState.error ? "field-invalid" : ""}`}
          value={settings.portSpec}
          onChange={(event) => onChange({ portSpec: event.target.value })}
          placeholder={defaultPorts.join(", ")}
          spellCheck={false}
          disabled={!settings.scanServices}
          aria-invalid={portState.error ? true : undefined}
          aria-describedby="port-spec-help"
        />
        <p id="port-spec-help" className="mt-1 text-[11.5px] leading-snug">
          {portState.error ? (
            <span className="text-danger">{portState.error}</span>
          ) : (
            <span className="text-ink-muted">
              {settings.portSpec.trim().length === 0
                ? `Empty means the default technician set: ${defaultPorts.length} ports covering remote desktop, file shares, SSH, web management, printing, databases and phones.`
                : `${effectivePortCount} ${effectivePortCount === 1 ? "port" : "ports"} selected. Single ports, lists and ranges: 22, 80, 443, 8000-8010.`}
            </span>
          )}
        </p>
      </section>

      <section className="mb-5">
        <SectionTitle>Performance</SectionTitle>
        <p className="mb-3 text-[11.5px] leading-snug text-ink-muted">
          The defaults are conservative on purpose. Small-business switches and access points drop
          ARP replies under heavy fan-out, which makes real devices vanish from a scan, so a gentler
          sweep usually finds more in one pass than an aggressive one.
        </p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <NumberField
            label="Probe timeout"
            value={settings.timeoutMs}
            onChange={(timeoutMs) => onChange({ timeoutMs })}
            min={50}
            max={10_000}
            step={50}
            unit="ms"
            hint="Raise it for a slow link or a VPN."
          />
          <NumberField
            label="Addresses at once"
            value={settings.hostConcurrency}
            onChange={(hostConcurrency) => onChange({ hostConcurrency })}
            min={1}
            max={512}
            hint="How many addresses are worked on in parallel."
          />
          <NumberField
            label="TCP probes at once"
            value={settings.tcpConcurrency}
            onChange={(tcpConcurrency) => onChange({ tcpConcurrency })}
            min={8}
            max={1_024}
            hint="The ceiling across the whole scan. Lower this first if devices come and go between scans."
          />
          <NumberField
            label="Pings at once"
            value={settings.pingConcurrency}
            onChange={(pingConcurrency) => onChange({ pingConcurrency })}
            min={1}
            max={128}
            hint="Each ping is a process, so this stays the tightest limit."
          />
        </div>
      </section>

      <section>
        <SectionTitle>Appearance</SectionTitle>
        <div className="flex items-center gap-4">
          <div>
            <label className="field-label" htmlFor="theme-select">
              Theme
            </label>
            <select
              id="theme-select"
              className="field w-40"
              value={settings.theme}
              onChange={(event) =>
                onChange({ theme: event.target.value as Settings["theme"] })
              }
            >
              <option value="system">Follow Windows</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="density-select">
              Row height
            </label>
            <select
              id="density-select"
              className="field w-40"
              value={settings.density}
              onChange={(event) =>
                onChange({ density: event.target.value as Settings["density"] })
              }
            >
              <option value="compact">Compact</option>
              <option value="comfortable">Comfortable</option>
            </select>
          </div>
        </div>
      </section>
    </Modal>
  );
}
