# Changelog

All notable changes to EXP IP Scanner are recorded here. The same history, in a
form built for reading, is on the
[website](https://kingnazz.github.io/EXP-IP-Scanner/releases.html).

This project uses [semantic versioning](https://semver.org/).

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
