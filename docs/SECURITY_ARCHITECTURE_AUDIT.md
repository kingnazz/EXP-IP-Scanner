# Security feature: pre-implementation architecture audit

Audited baseline: `7cbea1b2027fc9dc780bdf4ffc81a8042b4adfca` (1.3.0).
Feature branch: `feature/security-analysis`. No version or release changes planned.

## Existing architecture

1. **Scan pipeline:** `commands::scan_network` validates `ScanOptions` through
   `scanner::plan`, assigns a scan ID, and bridges a bounded 512-event Tokio
   channel to Tauri events. `scanner::run` probes IPv4 targets using OS ping and
   TCP, streams initial hosts, resolves DNS, settles/re-primes ARP, filters
   proxy ARP, and emits final enriched hosts. Cancel returns partial results.
2. **Ports:** `ports.rs` owns the consultant port catalog, default set and port
   parser (1,024 ports maximum). TCP connect success means open; RST also proves
   liveness. There is no application-layer service or banner detection. Service
   names in the UI are port hints, not verified protocols.
3. **Models:** serde Rust `HostResult`, `ScanResult`, `ScanOptions` and events
   mirror snake_case TypeScript interfaces in `src/types.ts`. Hosts have IP,
   hostname, MAC/vendor, ports, latency, TTL/OS hint, self flag and observation
   time. No persistent result database; explicit CSV export only.
4. **UI:** React 19 + TypeScript + Tailwind 4. `App` composes scan bar, network
   summary, toolbar, virtualized results table and device drawer. Shared theme
   tokens, badges, buttons, detail rows and accessible `Modal` provide the
   presentation language. `useScan` batches events every 100 ms, discards stale
   scan IDs, and preserves Watch Mode comparison semantics.
5. **Concurrency:** Tokio has separate limits of 64 hosts, 256 global TCP
   attempts and 32 ping subprocesses (clamped). Notifications interrupt waits
   on cancellation. DNS uses blocking-task isolation. Table virtualization
   starts above 150 rows. Security I/O must not enter discovery futures.
6. **Services:** `src/lib/api.ts` is the sole frontend/native boundary and has
   a deterministic browser demo fallback. Backend commands are narrow named
   capabilities; the webview has no generic shell/filesystem/network grant.
   `save_text` validates absolute CSV paths and limits writes to 32 MiB.
7. **Tests:** Vitest/jsdom tests cover scan state, live event merging, watch
   comparisons, components, actions, formatting, preferences, CSV, updates and
   public-IP behavior. About 100 Rust tests cover parsers, scan limits,
   cancellation/backpressure, discovery, launch validation and edition rules.
   Playwright scripts exercise assembled demo UI, responsiveness and website.
8. **Packaging/updates:** Tauri 2 Windows NSIS installer and separately compiled
   portable executable/ZIP. The portable feature excludes updater dependencies
   and uses its own WebView profile. CI tests both editions and builds Windows
   artifacts on PRs. Official release automation is version-gated on main;
   signed updater feed, public site and mirror workflows must remain intact.

## Insertion points and decisions

- Add a Rust `security` service with separate models, bounded HTTP/TLS transport,
  fingerprints, local intelligence and centralized scoring. Reuse Tokio/serde
  and existing host/result models. Reuse the installed updater's reqwest/rustls TLS stack; keep
  remote HTML in Rust memory only and return curated evidence, never page bodies.
- Invoke Safe Scan automatically from `useScan` after basic discovery resolves.
  Security has its own cancellation and generation IDs and bounded event
  stream. New scans/Watch passes cancel old assessment work. Discovery duration
  and host events remain unchanged; security failures cannot fail discovery.
- Keep per-device assessments alongside hosts rather than changing every host
  constructor, event merge, comparison and existing CSV contract.
- Add Security navigation, assessment cards/list/details, a subtle existing
  device-drawer indicator and JSON export through the existing save capability.
- Deep Scan is a separate, explicit confirmation boundary. Initially it only
  repeats the same low-impact checks; no exploit implementation or escalation.
- Default port catalog will include missing common web/DSM ports. Custom port
  selection remains authoritative. Every discovered port can be considered for
  web detection within a documented per-device budget; no new port sweep.

## Intelligence provenance

The requested CVE IDs `CVE-2026-109618` and `CVE-2026-109619` returned 404 in the
public CVEProject/cvelistV5 records during this audit (2026-10-22). This does not
establish whether they are reserved or valid. The requested PHP version cases
will be encoded as **user-supplied, unverified intelligence**, with explicit
provenance in UI/reports. Matching versions can yield a possible exposure, never
a confirmed vulnerability. Vendor backports/configuration cannot be inferred
from an HTTP version string. Correcting intelligence must require only a local
definition update and matching fixture updates.
