# Changelog

All notable changes to EXP IP Scanner are recorded here. The same history, in a
form built for reading, is on the
[website](https://expipscanner.com/releases.html).

This project uses [semantic versioning](https://semver.org/).

## 1.2.2

### Changed

- Retired the experimental ScreenConnect Backstage console companion after
  real-world antivirus and remote-shell compatibility proved inconsistent.
- Releases now ship only the two supported editions: Portable and Installer.
- The portable ZIP is simple again: `EXP IP Scanner.exe` plus its README.
- CI, release packaging, checksums, website download logic, and documentation no
  longer build, publish, bundle, or advertise a separate Backstage executable.

### Notes

- The main scanner and its network-discovery behavior are unchanged.
- Version 1.2.1 remains in the historical changelog because it did ship the
  experimental companion; 1.2.2 is the supported replacement.

## 1.2.1

### Added

- A dedicated **EXP IP Scanner Backstage** console companion for ScreenConnect
  Backstage and other limited remote shells. It uses the same Rust scanning
  engine as the desktop app without opening a Tauri window or requiring WebView2.
- The Backstage companion auto-detects the recommended local subnet, streams
  discoveries, and prints IP, hostname, MAC, manufacturer, latency, and open services.
- Backstage supports `--target`, `--ports`, `--no-services`, `--csv`, and
  `--json` for scripted or ticket-friendly workflows.
- The standalone Backstage EXE is published as its own release asset and is also
  included in the portable ZIP.

### Changed

- The website now exposes a dedicated Backstage download option.
- Portable packaging and CI verify the Backstage executable architecture and
  ensure it stays updater-free.

## 1.2.0

### Added

- The network summary strip now has a one-click copy action that puts the adapter,
  local IP, default gateway, scan range with address count, and public IP into
  one clean block for a ticket, handoff, Teams message, or work note.

### Changed

- The **Ping** action tooltip now correctly describes the four-probe diagnostic
  introduced in 1.1.7 instead of saying it sends one ping.
- The website public-IP FAQ now matches the full privacy notice: the lookup
  service necessarily sees the public address making the request, while EXP IP
  Scanner sends no identifier, scan results, or discovered-device data.

## 1.1.7

### Changed

- The in-app **Ping** diagnostic now sends four probes instead of one and
  reports sent/received counts, packet loss, minimum, average, and maximum
  latency, plus TTL when available. **Ping in a command prompt** remains the
  continuous option for watching a device reboot.
- Website deployments now rebuild the current application UI and regenerate
  the product screenshots automatically before publishing. The website can no
  longer drift back to screenshots from an older release.

## 1.1.6

### Added

- Results now surface the hidden row interactions instead of expecting a consultant
  to discover them by accident: **Double-click for details · Right-click for actions**
  appears as a subtle hint when the toolbar has room.
- Every device row carries the same interaction hint as a hover tooltip, so the
  details drawer and quick-action menu remain discoverable even when the toolbar
  hint is hidden at narrower widths.
- The search-clear icon now has an explicit tooltip like the other icon-only
  controls.

### Changed

- The discoverability hint automatically disappears when the results area gets
  tight, including when the device-details drawer is open, so it does not crowd
  the working controls.

## 1.1.5

### Added

- The installed edition now checks quietly for a newer stable release shortly
  after startup.
- When an update is available, the top bar shows a compact **Update vX.Y.Z**
  indicator with an attention icon. Clicking it opens About directly to the
  update controls.
- The About dialog reuses the background check result, so a signed update can
  go straight to **Install and restart** without making the user check twice.

### Changed

- Startup update-check failures stay silent. Manual **Check now** still reports
  errors normally.
- The portable edition remains unchanged and performs no update check.

## 1.1.4

### Added

- **Install and restart** support is now enabled for the installed edition.
  Signed releases include the Tauri updater signature and `latest.json`, so
  future versions can be downloaded, verified, installed, and relaunched from
  the About dialog instead of opening the browser download page.

### Changed

- Release publishing now requires the updater signing key to be configured.
  If signing is unavailable, the release stops before publishing rather than
  shipping an unsigned installer that installed copies cannot trust.
- The portable edition remains intentionally self-contained and never updates
  itself.

### Upgrade note

- Versions 1.1.3 and earlier were built before the signing public key was
  embedded. Install 1.1.4 manually once. After 1.1.4 is installed, later
  releases can use **Install and restart** directly in the app.

## 1.1.3

### Added

- **Copy IPs** in the results toolbar copies only the IP addresses for the
  selected devices, or every currently shown device when nothing is selected.
  Addresses are copied one per line so they can go straight into scripts,
  firewall rules, tickets, spreadsheets, or another network tool.
- Copy IPs follows the same search, filter, and multi-select rules as the
  existing Copy and Export actions, so what you see is exactly what gets copied.

### Changed

- Release and updater links continue to use EXP's company-owned repository as
  the permanent download/update authority introduced in 1.1.2.

## 1.1.2

### Changed

- EXP's company-owned repository, `nazar-exp/EXP-IP-Scanner`, is now the
  permanent update authority for the application.
- The installed edition's **Check now** flow reads the latest stable release
  from the EXP-owned repository instead of a personal GitHub account.
- The future signed Tauri updater feed now points at the EXP-owned repository.
- In-app Website, Releases, Downloads, and Privacy links now open the EXP-owned
  GitHub Pages site and repository.
- The product website, canonical metadata, sitemap, release history, and
  download resolver now use the EXP-owned project as their source of truth.

### Notes

- The personal development repository continues to build releases and mirrors
  the exact code, tags, release notes, installer, portable ZIP, and checksums
  into the EXP-owned repository automatically.
- Existing 1.1.1 installations can discover 1.1.2 through the personal release
  channel one last time. After installing 1.1.2, future update checks use the
  EXP-owned repository.

## 1.1.1

### Fixed

- The installed edition's **Check now** button no longer treats a missing signed
  Tauri updater manifest as a failed update check. It now asks GitHub Releases
  which stable version is current first.
- When a newer release exists but no signed in-app updater manifest is available,
  About offers **Open download** instead of showing an invalid-release-JSON
  error. If signing is configured later, the same flow automatically keeps the
  **Install and restart** path.
- The application Content-Security-Policy now explicitly allows the GitHub API
  used by the manual update check.

### Notes

- Update checking still runs only when the consultant presses **Check now**.
  It does not run at startup or in the background.

## 1.1.0

### Added

- A network summary strip under the scan bar: the adapter, this machine's
  address, the default gateway, what is about to be swept, and this network's
  public IP address. Every value copies to the clipboard when clicked.
- Default gateway detection, read from the routing table and matched to the
  adapter the route leaves by, so a laptop with a VPN up shows the tunnel's
  gateway on the tunnel and the wired one on the NIC. An adapter with no default
  route says so rather than being given an invented one.
- Public IP lookup, so a consultant on site can read the address the network
  appears as from outside without opening a browser. It runs asynchronously and
  never delays startup, falls back to a second service, says "Unavailable"
  rather than failing loudly when neither can be reached, and can be looked up
  again on demand. It is the only request the application makes on its own, it
  sends nothing, and it can be turned off in Settings.

### Changed

- EXP IP Scanner now carries the EXP brand. The logo appears in the title bar
  and in About, the accent colour throughout the interface is the EXP orange
  that the website already used, and the application, executable, installer,
  window and website icons are all derived from the same artwork.
- The adapter selector in the scan bar shows just the adapter now. Its address
  and subnet moved into the network summary below it rather than being printed
  twice within 30 pixels.

### Notes

- No new permission, dependency or capability. The public IP lookup is made by
  the window itself, and `connect-src` in the Tauri configuration names the only
  two hosts it may reach.

## 1.0.0

First release.

### Added

- Automatic detection of the network you are on, with the scan target filled in
  before you touch anything. Adapter ranking prefers a wired or wireless NIC
  over a Hyper-V switch, a Docker bridge, a VMware host-only adapter or a VPN
  tunnel, and every adapter stays selectable. A very large flat network is
  narrowed to the containing /24 rather than offered as a sweep of 65,000
  addresses.
- Device discovery over ICMP, TCP and the ARP cache, with a second ARP pass so a
  device that was slow or lossy on the first sweep does not disappear between
  scans, and proxy-ARP defence so a router answering for its whole subnet does
  not make every address look occupied. No administrator rights required.
- Hostname resolution running alongside the sweep, so names appear while the
  scan is still going.
- MAC addresses and manufacturer names from the full IEEE OUI registry, embedded
  in the binary and resolved with no network access of its own.
- Detection of 32 services that matter on a business network — remote desktop,
  file shares, SSH, web management, printing, databases, directory services and
  phones — shown with their names rather than as bare port numbers.
- Remote Desktop, file share, SSH, VNC and web-interface shortcuts, plus ping in
  the details panel and ping or traceroute in a command prompt. Each is enabled
  only where a device's open ports support it, and says why when it is not.
- A results table with numeric address sorting, resizable and optional columns
  whose widths persist, instant search across every field, three filters,
  multi-select, keyboard navigation and a right-click menu.
- A device details panel that opens beside the results rather than replacing
  them, so a running scan is never interrupted.
- CSV export that opens cleanly in Excel, and tab-separated copy for pasting
  into a ticket, an email or a spreadsheet.
- Light and dark themes, following Windows by default.
- A portable edition that needs no installation, never writes to the folder it
  was extracted into, and contains no updater at all; and an installer edition
  that can check GitHub for a newer version when asked.

### Notes

- There is deliberately no inventory database, no scan history and no change
  tracking. Scan results live in memory until exported, because the same copy of
  this tool gets pointed at many unrelated customer networks.
- Windows 10 and Windows 11, x64.
