# Security analysis: developer guide

Read the [pre-implementation architecture audit](SECURITY_ARCHITECTURE_AUDIT.md)
for the baseline, existing scan engine, UI, packaging and insertion decisions.

## Data flow and ownership

`scanner::run` remains responsible for discovery. It retains the existing event
contract, concurrency, cancellation, ARP/DNS enrichment and CSV behavior.
`commands::scan_network` registers its final result with the security adapter.
`useScan.securitySource` starts `useSecurity` automatically after discovery.
Assessment runs separately: discovery stays usable while security results arrive.
Cancelled discovery retains partial results but does not automatically start
new HTTP requests; Safe Scan can be explicitly requested for those results.
Starting another scan (including Watch Mode), clearing, stopping an assessment or
closing the app cancels/invalidate old work. Security errors cannot reject a
successful discovery.

`src-tauri/security` is a small Rust library in the existing Cargo workspace, not
another application. It separates models, transport, fingerprints, intelligence
and assessment orchestration. This allows deterministic tests without a WebView
or GTK build. `src-tauri/src/security.rs` supplies the narrow Tauri commands and
only accepts the most recent discovery's scan ID, never arbitrary URLs/host lists.
Device assessments are separate from `HostResult`, preserving discovery merging,
Watch comparisons, existing actions and CSV contracts. Security events are batched in native code (up to 25 devices or a 100 ms interval)
and React repaints at most every 100 ms while streaming. The device list is
paginated at 40 items, sorted by lowest score, keeping large scans bounded in
the DOM. Results remain in memory
and are saved only by an explicit JSON export.

The `security:device` event includes both discovery ID and assessment ID. The
React hook invalidates its active generation before asking native code to cancel,
rejecting late events/completion. A backend cancellation watermark also rejects
cancelled requests that arrive late. Native work is globally bounded, including
when a replacement assessment overlaps cleanup of an old one.

## Safe Scan network behavior

- Uses only open ports already found by discovery. Defaults now also cover
  5000, 5001 and 8888. Custom port selection stays authoritative.
- Prioritizes 80, 443, 8080, 8443, 8000, 8888, 5000, 5001. Other discovered ports
  are eligible; known non-web protocols, particularly raw printing, are excluded.
- Up to 12 eligible ports per device, four devices concurrently, globally eight
  HTTP operations, one operation at a time per device. A device has 12 seconds;
  an assessment run has 120 seconds. Truncation/timeouts produce coverage notes.
- Requests `GET /` only. No extra admin paths or wordlists. Port hints select
  HTTP/HTTPS first; a failed protocol can try the other once. HTTPS validation
  failure can trigger one certificate-inspection retry. At most three requests
  per port, normally one. Endpoints are deduplicated and cached for that run.
- Two-second total HTTP request timeout, one-second connection timeout. A slow
  body shares the request deadline. Cancellation drops pending requests.
- Identifies itself as `EXP-IP-Scanner/Safe-Assessment`. No proxy, credentials,
  cookie persistence, remote JavaScript, file upload or execution.
- Redirects are recorded, never fetched. Only HTTP(S) destinations are displayed;
  credentials, query strings and fragments are removed. No redirect can expand
  the scan to a different host or scheme.
- HTTP/1 only; max 64 response headers, 16 KiB header acceptance limit and 512
  characters per retained header. The underlying HTTP parser also has its own
  bounded header buffer (hyper's default); the 16 KiB check is after parsing.
  Inspect at most 64 KiB of HTML/text body, with decoding replacement for invalid
  UTF-8. Parsing is HTML-only; nothing is executed. IPC exposes selected metadata
  and curated evidence, never full bodies, cookies or arbitrary header values.
- React renders every remote value as text. Control/bidi formatting characters
  are removed and display fields bounded. CSP/network permissions are unchanged.

Unknown ports can speak non-HTTP protocols. Review selected ports for unusual
industrial/legacy equipment; Safe Scan is low-impact, not a guarantee that every
possible device will handle an ordinary connection identically.

## Fingerprints and confidence

`fingerprint::detect` consumes bounded response headers and HTML. Structured
signals include Server/X-Powered-By, generator metadata, asset paths, page title
and login form actions. Supported families: Synology DSM and Web Station,
WordPress, Apache, nginx, IIS, PHP, explicit PHP-FPM indicators, Drupal, Joomla,
Nextcloud, phpMyAdmin and Webmin. Several independent signals raise confidence; a title
alone never establishes a PHP app. Article text mentioning a product is not
proof. PHP inferred from an app never invents a PHP version. DSM/Web Station do
not establish that a particular PHP package is installed.

Admin findings require recognizable interface evidence. A reachable admin page
is an attack-surface observation, not proof of a vulnerability. Internet exposure,
network ACLs, authentication strength and share permissions are not tested.

## TLS boundary

The HTTP client uses the existing reqwest/rustls stack with the ring provider,
sharing dependencies with the installed updater. It does not enable reqwest
native-tls: Cargo feature unification would otherwise change the updater
client's default TLS backend. The portable edition gains the same TLS stack
without linking the updater plugin. OS trust roots are used through the platform
verifier.
Validated HTTPS is attempted first. A separate inspection client can obtain an
untrusted certificate and public root page, without credentials; it is never
used for updates or any authenticated action. Trust failure is explicit.
X.509 parsing records subject, issuer, expiry, not-yet-valid state, IP SAN mismatch
and matching subject/issuer as a **self-signed indication**. It does not prove the
certificate's signature is self-signed. Identity is checked against the actual
IP endpoint, not untrusted reverse DNS. DNS-only certificates may therefore
legitimately mismatch an IP. Obsolete TLS protocol support is not enumerated;
clients require TLS 1.2 or newer. Failed handshakes are coverage gaps.

## Local intelligence format

`intelligence/vulnerabilities.json` is compiled into the binary with no runtime
cloud feeds. Schema version 1 contains a definitions array:

```json
{
  "id": "product-advisory",
  "title": "Exposure assessment",
  "severity": "High",
  "affected_product": "PHP",
  "affected_versions": [{
    "branch": "8.2", "from_inclusive": "8.2.0", "patched_from": "8.2.35"
  }],
  "cve_ids": ["CVE-YYYY-NNNN"],
  "description": "Explain preconditions and uncertainty.",
  "remediation": "Vendor-supported remediation.",
  "references": ["https://vendor.example/advisory"],
  "detection_type": "exposed_version",
  "verified": false,
  "provenance": "Source, date and verification status."
}
```

This example describes the format, not verified vendor intelligence. Version
comparison accepts strict three-component numeric releases. Vendor suffixes,
prereleases, unknown versions and uncovered branches return UNKNOWN. Never strip
a distribution suffix then claim upstream patch status. `from_inclusive` includes
the lower bound; `patched_from` is the first supplied patched version in that
branch. Only verified definitions with high-confidence version evidence can
produce LIKELY VULNERABLE, never Confirmed from banner matching.

PHP2Shell's CVE IDs and thresholds are **user-supplied and unverified**. The
requested six cases are fixture-backed, and matching unverified ranges yield
POSSIBLY VULNERABLE with Low confidence. PATCHED means at/above the supplied
threshold, not verified vendor remediation. Unknown PHP yields UNKNOWN; absent
PHP evidence yields NOT APPLICABLE for that response, not proof of global absence.
The caveat is present in findings, the Security view and exported reports.

To add a version advisory: obtain vendor evidence, normalize its product name to
a fingerprint, add the definition with provenance, cover boundaries/unknowns and
false positives in tests, then review the output. For other detection types, add
a pure evaluation function and dispatch from the intelligence layer; UI stays
unchanged. Keep active verification outside this pipeline.

## Findings, scores and reports

`models.rs` and `src/security-types.ts` mirror snake_case serde fields. `Finding`
contains ID/title, severity/status, optional exposure status, device/host/port/
protocol/product/version/CVEs, confidence/evidence, description/remediation,
references and timestamp. IDs are stable per IP/port/protocol/check. Confirmed
means an observed property (for example, expired certificate), not exploited
code execution. NotAffected and Informational statuses do not reduce scores.

`intelligence/scoring.json` centralizes configurable deductions: Critical 30,
High 15, Medium 7, Low 3, Informational 0. Expired TLS uses 8 and exposed admin
uses 5 **instead of** its severity deduction. Start at 100, subtract once per
finding ID, clamp to zero. Separate endpoints may have distinct deductions.
This is an EXP-IP-Scanner assessment score, not an industry score or proof of
security. The UI shows every deduction and coverage notes.

JSON reporting reuses the native save dialog and `save_text` validation (CSV and
JSON only, absolute path, 32 MiB maximum). Schema version 1 preserves target,
discovery scope/ports/time/partial state, assessments, findings, critical/high
summary, affected systems and deduplicated remediation. This structured model
can support future HTML/PDF without reparsing UI text. Export during work is
explicitly marked partial.

## Deep Scan boundary

Deep Scan requires the separate dialog and a checked authorization statement:
“Only scan systems you own or are authorized to test.” Its native service policy
also requires confirmation. Currently it only repeats Safe Scan checks and says
so. There is no exploit, authentication bypass, command injection, brute force,
share enumeration or intrusive PoC implementation. New active checks must be
added behind this separate service boundary with a reviewed per-check consent
and cancellation contract. Safe Scan must never call them automatically.

## Testing and packaging

```sh
npm ci
npm test
npm run build
npm run check-version
cargo test --manifest-path src-tauri/Cargo.toml -p exp-security
cargo clippy --manifest-path src-tauri/Cargo.toml -p exp-security --all-targets -- -D warnings
cargo test --workspace --manifest-path src-tauri/Cargo.toml
cargo test --workspace --manifest-path src-tauri/Cargo.toml --no-default-features --features portable
```

Core tests need no WebView or GTK. Full app tests/builds need Tauri's documented
platform prerequisites. All security HTTP tests use loopback sockets and fixtures,
never public services. Test certificates/private keys are synthetic fixtures only.
Coverage includes fingerprint false positives, supplied PHP branch thresholds,
version normalization, findings/scoring, TLS/certificates, malformed/oversized
responses, timeouts, no-follow redirects, cancellation/generations and UI consent.
The browser demo has explicitly labelled sample findings and makes no security
requests. `scripts/verify-security.mjs` tests the assembled demo at minimum and
default window sizes, JSON export and confirmation flow.

No public version bump, updater change, release publication or merge belongs to
this feature. Windows NSIS and portable packaging remain in existing PR CI.
