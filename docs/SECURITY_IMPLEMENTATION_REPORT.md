# Security module implementation report

Branch: `feature/security-analysis`. Public version: **1.3.0, unchanged**.
No merge, tag, release publication or updater feed change.

## 1. Architecture findings

The [pre-implementation audit](SECURITY_ARCHITECTURE_AUDIT.md) documents the
existing pipeline, port architecture, models, React UI, Tokio limits, services,
tests, edition packaging and update system. The existing discovery engine is
preserved. Security runs after discovery through the existing Tauri/API/hook
pattern; it cannot reject discovery. Stopped discovery does not automatically
start web requests against partial results.

## 2. Files changed

The complete file inventory is at the end of this report. Changes are limited
to assessment integration, the new Rust library, React views/state, tests,
local definitions and documentation. The release workflow, public version,
updater feed/key and edition isolation are preserved.

## 3. New components, services and models

- `exp-security` Rust workspace library: bounded web/TLS transport, multi-signal
  fingerprints, local vulnerability evaluator, finding generation and scoring.
- Native security adapter: current-discovery target restriction, assessment
  generations, cancellation, batched events and Deep Scan confirmation.
- `useSecurity`, `SecurityView`, JSON report builder and labelled browser demo.
- Standard `Technology`, `TlsResult`, `WebService`, `Finding`, `SecurityScore`,
  `DeviceAssessment` and `AssessmentRun` models, with mirrored TypeScript types.
- Separate `DeepScanPolicy` and `DeepScanService`. The current implementation
  repeats low-impact checks only and requires explicit authorization.

## 4. Checks implemented

HTTP/HTTPS root response status, safe redirect display (never followed), title,
server/version headers, CMS/framework metadata, PHP and explicit PHP-FPM
indicators. Fingerprints cover DSM, Web Station, WordPress, Apache, nginx, IIS,
Drupal, Joomla, Nextcloud, phpMyAdmin and Webmin. Structural evidence supports
recognizable management-interface findings. No PHP package inventory is inferred
from a Synology name.

TLS checks cover trust/validity, expiry, not-yet-valid dates, subject/issuer,
IP SAN mismatch and self-signed indication. Unencrypted HTTP is flagged.
Scoring is centralized in local JSON and every deduction is exposed.

PHP2Shell's requested identifiers and thresholds are **supplied, unverified
intelligence**. Public CVEProject lookups returned 404; that does not establish
whether the identifiers are reserved or valid. Matching versions yield possible
exposure with Low confidence, never Confirmed. Unknown versions stay UNKNOWN;
PATCHED is explicitly relative to the supplied threshold, not vendor patch
confirmation. Definitions and provenance can be corrected independently of UI.

## 5. UI changes

Scan Web Exposure is a one-click action beside the navigation tabs. It discovers
all addresses in the current target with common web ports plus selected services,
then uses Safe Scan automatically. Overrides apply only to that run; saved
settings and normal Scan/Watch behavior stay unchanged. Discovery progress and
Stop are available within Security. No table selection or search narrows scope.

Security navigation, severity/device summary cards, searchable device list with
40-item pagination and lowest scores first, scores/factors, coverage notes,
technology evidence, service/TLS details, finding/remediation dialog and native
JSON export. Existing rows get a small shield for material findings; the device
drawer gains a short security summary and link. Themes/tokens, badges, Modal,
scanner virtualization, actions and CSV behavior are reused.

Deep Scan has a separate authorization checkbox and clearly states that this
phase only repeats low-impact checks. Browser data is labelled illustrative.

## 6. Tests added

24 Rust tests cover DSM/WordPress/Webmin fingerprints, PHP-FPM/server headers,
article/asset-query false positives, strict numeric versions, all six requested
PHP version cases, unknown/absent PHP, provisional finding generation, score
weights/deduplication/clamping, certificate dates/IP names/self-signed indication,
malformed DER/HTML/HTTP, IPv6 URL formatting, safe/no-follow redirects, identified
requests, response/header caps, timeouts, cancellation, cache/deduplication,
known raw-printer exclusion, global concurrency and end-to-end finding output.

15 frontend tests cover the one-click full-target exposure pipeline, per-run
port/service overrides and saved settings, stopped discovery/Watch separation,
reporting, conservative counts, Deep Scan consent,
escaped remote text, finding details, bounded pagination/search, automatic Safe
Scan, stopped discovery, stale events/cancellation and assessment error isolation.
The browser verification script covers summary/details, default/minimum layouts,
consent, JSON download and returning to the original scanner.

All HTTP tests use loopback fixtures; no test relies on a public target.

## 7. Verification results

- Frontend: **240 tests passed**, including existing packaging/updater tests.
- Installed Rust workspace: **124 passed** (100 existing + 24 security tests).
- Portable Rust workspace: **124 passed**.
- Rustfmt and Clippy with warnings denied: installed and portable checked.
- Existing full browser interface suite: passed (four window sizes, discovery,
  filtering, selection, actions, export, Watch Mode, layout and responsiveness).
- Security browser flow: passed at 1180×780 and 860×560.
- Public version consistency: passed at 1.3.0.
- Dependency audit: zero npm vulnerabilities after compatible development-tool
  patches (Vite 8.3.5, Vitest 5.0.5 and source-map-js 1.2.2). Existing vulnerable
  locked versions initially blocked PR CI; no application version bump.

## 8. Build and packaging

`npm run build` passes typechecks and production bundling. A Linux portable
edition desktop binary with embedded frontend (`portable,custom-protocol`) builds
successfully. Windows NSIS/portable ZIP packaging uses the existing PR CI job;
Windows artifacts are not claimed as locally built in this Linux environment.
The draft PR is the review surface for those CI artifacts. No release is
published. Temporary build prerequisites were extracted outside the repository.

Assessment reuses the updater's existing reqwest/rustls/ring dependencies. It
does not enable reqwest native-tls, which would silently change the updater's
backend through Cargo feature unification. Insecure certificate inspection is
client-scoped; updater verification remains unchanged.

## 9. Known limitations

- PR dependency CI still flags Rust advisories in versions inherited from the
  base repository: rustls 0.23.45, rustls-webpki 0.103.15,
  webpki-root-certs 1.0.9 and zip 4.6.1. The npm audit is clean; the Rust audit
  remains a merge/release blocker and has not been suppressed. Resolving the
  ZIP advisories requires reviewing Tauri's transitive dependency constraints.
  The Scan Web Exposure action adds no dependencies.

- Provisional PHP2Shell intelligence requires vendor verification before it is
  treated as authoritative. Banner matches cannot establish exploitability,
  backports, configuration or installed packages.
- Discovery remains IPv4, as before. The assessment transport supports IPv6 IP
  endpoints, but this feature does not add IPv6 network discovery.
- Requests use the IP endpoint: DNS-only certificates can legitimately mismatch
  it. SNI/virtual-host content, authentication, Internet reachability and firewall
  policy are not inferred. TLS protocol/cipher enumeration is not performed.
- Root pages only, no redirect following or admin-path enumeration. Hidden
  versions/login paths and compressed/unrecognized content can be missed.
  Some services on unusual HTTPS ports may reject an initial HTTP request.
- Per-device/whole-run budgets can leave unassessed devices or ports. Known
  non-web protocols are excluded; unknown/custom services are considered within
  the budget. Low-impact requests are not a universal compatibility guarantee.
- Score 100 means no deductions from available observations, not a secure device.
- Native Windows installer and portable smoke tests still require review of CI
  artifacts on Windows. Binary size/performance on representative MSP networks
  should be measured before a release.

## 10. Recommended Phase 2

1. Verify advisories/vendor version ranges and backport policies; design reviewed,
   versioned offline intelligence updates with clear provenance.
2. Expand fixture-backed service signatures and optional operator-supplied DNS/SNI
   targets; profile budgets on representative NAS, printers and MSP networks.
3. Add scoped, explicitly selected non-destructive verification checks behind the
   Deep Scan service boundary, with per-check consent and cancellation.
4. Build sanitized HTML/PDF reports from the JSON schema and add reusable MSP
   assessment policies. Keep uncertainty and coverage prominent.
5. Complete Windows artifact smoke tests, startup/binary-size measurements and
   a product review before any public version bump or release.

## Complete file inventory
- `.github/workflows/ci.yml`
- `README.md`
- `docs/SECURITY_ANALYSIS.md`
- `docs/SECURITY_ARCHITECTURE_AUDIT.md`
- `docs/SECURITY_IMPLEMENTATION_REPORT.md`
- `package-lock.json`
- `scripts/verify-security.mjs`
- `src-tauri/Cargo.lock`
- `src-tauri/Cargo.toml`
- `src-tauri/security/Cargo.toml`
- `src-tauri/security/intelligence/scoring.json`
- `src-tauri/security/intelligence/vulnerabilities.json`
- `src-tauri/security/src/fingerprint.rs`
- `src-tauri/security/src/intelligence.rs`
- `src-tauri/security/src/lib.rs`
- `src-tauri/security/src/models.rs`
- `src-tauri/security/src/transport.rs`
- `src-tauri/security/tests/assessment.rs`
- `src-tauri/security/tests/fixtures/dsm.html`
- `src-tauri/security/tests/fixtures/expired.der`
- `src-tauri/security/tests/fixtures/false-positive.html`
- `src-tauri/security/tests/fixtures/future.der`
- `src-tauri/security/tests/fixtures/test-identity.p12`
- `src-tauri/security/tests/fixtures/valid.der`
- `src-tauri/security/tests/fixtures/wordpress.html`
- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/ports.rs`
- `src-tauri/src/runtime.rs`
- `src-tauri/src/security.rs`
- `src/App.test.tsx`
- `src/App.tsx`
- `src/components/DeviceDrawer.tsx`
- `src/components/ResultsTable.tsx`
- `src/components/SecurityView.test.tsx`
- `src/components/SecurityView.tsx`
- `src/hooks/useScan.ts`
- `src/hooks/useSecurity.test.ts`
- `src/hooks/useSecurity.ts`
- `src/lib/api.ts`
- `src/lib/demo.ts`
- `src/lib/security-demo.ts`
- `src/lib/security.test.ts`
- `src/lib/security.ts`
- `src/security-types.ts`
- `src/test/security.ts`
