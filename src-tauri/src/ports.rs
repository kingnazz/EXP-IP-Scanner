//! TCP port specifications and the service-name table.
//!
//! Adapted from ArcScan's `ports` module. The validation strategy is reused
//! unchanged, because the reasoning behind it holds here too: the backend is
//! the source of truth for ports, so a malformed or oversized list cannot reach
//! the probe loop regardless of what the interface sent.
//!
//! What differs is the default set. ArcScan shipped a 14-port spread aimed at
//! fingerprinting. EXP IP Scanner probes the services a technician actually
//! acts on -- remote desktop, file shares, SSH, web management pages, printers,
//! databases, phone systems -- because the point of the scan is to click
//! through to the device afterwards.

use std::collections::BTreeSet;

/// Upper bound on how many distinct ports one scan may probe.
///
/// 1,024 ports across a /22 is already a million connection attempts, which is
/// the practical ceiling for an app that has to stay responsive and must not
/// overwhelm the customer's switch.
pub const MAX_PORTS: usize = 1_024;

/// The default technician service set.
///
/// Wide enough to recognise the devices on a business network at a glance and
/// to light up the right-click actions, small enough that a /24 finishes in
/// seconds. Not a security sweep: every port here exists because knowing it is
/// open tells a technician what the device is or gives them a way in to
/// administer it.
pub const DEFAULT_PORTS: [u16; 32] = [
    20, 21, 22, 23, 25, 53, 80, 110, 135, 139, 143, 389, 443, 445, 515, 587, 631, 993, 995, 1433,
    1723, 3306, 3389, 5060, 5432, 5900, 5985, 5986, 8000, 8080, 8443, 9100,
];

/// Validate, de-duplicate and sort a port list coming from the interface.
///
/// An empty list means "use the defaults". Port 0 is rejected rather than
/// quietly dropped: a caller asking for it has a bug worth seeing rather than a
/// silently different scan.
pub fn sanitize(ports: &[u16]) -> Result<Vec<u16>, String> {
    if ports.is_empty() {
        return Ok(DEFAULT_PORTS.to_vec());
    }
    if ports.contains(&0) {
        return Err("Port 0 is not a TCP port. Use 1 to 65535.".into());
    }
    let unique: BTreeSet<u16> = ports.iter().copied().collect();
    if unique.len() > MAX_PORTS {
        return Err(format!(
            "{} ports selected, more than the {MAX_PORTS} port limit. Use a shorter port list.",
            unique.len()
        ));
    }
    Ok(unique.into_iter().collect())
}

/// Parse a port specification as a technician would write one.
///
/// Accepts single ports, comma or space separated lists, ranges, and any mix:
/// `22`, `22,80,443`, `22 80 443`, `8000-8100`, `80, 443, 8000-8010`.
pub fn parse_spec(input: &str) -> Result<Vec<u16>, String> {
    let text = input.trim();
    if text.is_empty() {
        return Ok(DEFAULT_PORTS.to_vec());
    }
    let mut set: BTreeSet<u16> = BTreeSet::new();
    for raw in text.split(|c: char| c == ',' || c == ';' || c.is_whitespace()) {
        let token = raw.trim();
        if token.is_empty() {
            continue;
        }
        match token.split_once('-') {
            Some((a, b)) => {
                let start = parse_port(a.trim())?;
                let end = parse_port(b.trim())?;
                let (start, end) = if start <= end {
                    (start, end)
                } else {
                    (end, start)
                };
                // Refuse before expanding, so `1-65535` cannot allocate 64k
                // entries only to be turned down afterwards.
                let width = end as usize - start as usize + 1;
                if set.len() + width > MAX_PORTS {
                    return Err(format!(
                        "`{token}` adds {width} ports, taking the list past the {MAX_PORTS} port \
                         limit. Use a narrower range."
                    ));
                }
                set.extend(start..=end);
            }
            None => {
                set.insert(parse_port(token)?);
                if set.len() > MAX_PORTS {
                    return Err(format!(
                        "More than {MAX_PORTS} ports selected. Use a shorter port list."
                    ));
                }
            }
        }
    }
    if set.is_empty() {
        return Err("That port list contains no ports.".into());
    }
    Ok(set.into_iter().collect())
}

fn parse_port(token: &str) -> Result<u16, String> {
    let n: u32 = token
        .parse()
        .map_err(|_| format!("`{token}` is not a port number."))?;
    if n == 0 || n > 65_535 {
        return Err(format!("`{token}` is out of range. Ports are 1 to 65535."));
    }
    Ok(n as u16)
}

/// The short service name shown beside a port, e.g. the `SSH` in `22 SSH`.
///
/// A curated list of what turns up on business networks rather than the whole
/// IANA registry, so the Open Ports column reads as words a technician
/// recognises instead of a wall of numbers.
pub fn service_name(port: u16) -> Option<&'static str> {
    let name = match port {
        20 | 21 => "FTP",
        22 => "SSH",
        23 => "Telnet",
        25 | 587 => "SMTP",
        53 => "DNS",
        67 | 68 => "DHCP",
        69 => "TFTP",
        80 => "HTTP",
        88 => "Kerberos",
        110 => "POP3",
        111 => "RPC",
        123 => "NTP",
        135 => "MS RPC",
        137..=139 => "NetBIOS",
        143 => "IMAP",
        161 | 162 => "SNMP",
        389 => "LDAP",
        427 => "SLP",
        443 => "HTTPS",
        445 => "SMB",
        465 => "SMTPS",
        500 => "IKE",
        515 => "LPD",
        548 => "AFP",
        554 => "RTSP",
        631 => "IPP",
        636 => "LDAPS",
        993 => "IMAPS",
        995 => "POP3S",
        1080 => "SOCKS",
        1433 => "MSSQL",
        1521 => "Oracle",
        1723 => "PPTP",
        1883 => "MQTT",
        1900 => "SSDP",
        2049 => "NFS",
        2375 | 2376 => "Docker",
        3000 => "HTTP alt",
        3128 => "Proxy",
        3306 => "MySQL",
        3389 => "RDP",
        5000 => "UPnP",
        5060 | 5061 => "SIP",
        5222 => "XMPP",
        5353 => "mDNS",
        5432 => "PostgreSQL",
        5555 => "ADB",
        5900..=5905 => "VNC",
        5985 => "WinRM",
        5986 => "WinRM TLS",
        6379 => "Redis",
        8000 | 8008 | 8081..=8090 => "HTTP alt",
        8080 => "HTTP alt",
        8443 | 4443 => "HTTPS alt",
        8883 => "MQTTS",
        9000 => "HTTP alt",
        9100 => "Print",
        9200 => "Elasticsearch",
        10000 => "Webmin",
        27017 => "MongoDB",
        32400 => "Plex",
        _ => return None,
    };
    Some(name)
}

/// Every port this build can name, with its service word.
///
/// The interface fetches this once at startup instead of keeping its own copy,
/// so a name added here appears in the table and in search without a second
/// list to keep in step.
pub fn catalog() -> Vec<(u16, &'static str)> {
    (1..=u16::MAX)
        .filter_map(|port| service_name(port).map(|name| (port, name)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_spec_falls_back_to_the_defaults() {
        assert_eq!(parse_spec("   ").unwrap(), DEFAULT_PORTS.to_vec());
        assert_eq!(sanitize(&[]).unwrap(), DEFAULT_PORTS.to_vec());
    }

    #[test]
    fn the_default_set_is_sorted_unique_and_named() {
        let mut sorted = DEFAULT_PORTS.to_vec();
        sorted.sort_unstable();
        assert_eq!(
            sorted,
            DEFAULT_PORTS.to_vec(),
            "the default set is not sorted"
        );

        let unique: BTreeSet<u16> = DEFAULT_PORTS.iter().copied().collect();
        assert_eq!(
            unique.len(),
            DEFAULT_PORTS.len(),
            "the default set repeats a port"
        );

        for port in DEFAULT_PORTS {
            assert!(
                service_name(port).is_some(),
                "default port {port} has no service name, so the table would show a bare number"
            );
        }
    }

    #[test]
    fn the_default_set_covers_the_services_the_actions_depend_on() {
        // Every right-click action is gated on one of these being open, so a
        // port dropped from the defaults silently disables an action.
        for port in [22u16, 80, 443, 445, 3389, 5900] {
            assert!(
                DEFAULT_PORTS.contains(&port),
                "port {port} drives a device action and must be probed by default"
            );
        }
        // And the ports that identify the device classes a technician meets
        // most: printers, domain controllers, databases, phones.
        for (port, what) in [
            (9100u16, "raw printing"),
            (515, "line printer daemon"),
            (631, "IPP printing"),
            (389, "LDAP"),
            (1433, "SQL Server"),
            (5060, "SIP"),
            (5985, "WinRM"),
        ] {
            assert!(
                DEFAULT_PORTS.contains(&port),
                "port {port} ({what}) identifies a common device and must be probed by default"
            );
        }
    }

    #[test]
    fn a_default_scan_is_within_the_workload_budget_for_a_slash_22() {
        // 1,022 addresses times the default ports has to stay under the hard
        // limit, or the interface's own suggested target would be refused.
        let workload = 1_022u64 * DEFAULT_PORTS.len() as u64;
        assert!(
            workload < crate::scanner::MAX_WORKLOAD,
            "a default /22 sweep is {workload} probes, over the budget"
        );
    }

    #[test]
    fn parses_the_forms_people_type() {
        assert_eq!(parse_spec("443").unwrap(), vec![443]);
        assert_eq!(parse_spec("22,80,443").unwrap(), vec![22, 80, 443]);
        assert_eq!(parse_spec("22 80 443").unwrap(), vec![22, 80, 443]);
        assert_eq!(parse_spec("22, 80  443,").unwrap(), vec![22, 80, 443]);
        assert_eq!(parse_spec("80-82").unwrap(), vec![80, 81, 82]);
        assert_eq!(
            parse_spec("443, 80-82, 22").unwrap(),
            vec![22, 80, 81, 82, 443]
        );
    }

    #[test]
    fn a_reversed_range_is_accepted_and_ordered() {
        assert_eq!(parse_spec("82-80").unwrap(), vec![80, 81, 82]);
    }

    #[test]
    fn duplicates_collapse_and_output_is_sorted() {
        assert_eq!(parse_spec("443,80,443,80-81").unwrap(), vec![80, 81, 443]);
        assert_eq!(sanitize(&[443, 80, 443, 22]).unwrap(), vec![22, 80, 443]);
    }

    #[test]
    fn rejects_out_of_range_and_non_numeric_ports() {
        for bad in ["0", "65536", "-5", "http", "80,http", "80-abc"] {
            let err = parse_spec(bad).unwrap_err();
            assert!(!err.is_empty(), "no message for {bad:?}");
            assert!(
                !err.contains("ParseIntError"),
                "leaked internals for {bad:?}: {err}"
            );
        }
        assert!(sanitize(&[0, 80]).is_err());
    }

    #[test]
    fn enforces_the_port_limit_before_expanding() {
        let err = parse_spec("1-65535").unwrap_err();
        assert!(err.contains(&MAX_PORTS.to_string()), "{err}");
        assert_eq!(parse_spec("1-1024").unwrap().len(), MAX_PORTS);
        assert!(parse_spec("1-1024,3000").is_err());

        let too_many: Vec<u16> = (1..=(MAX_PORTS as u16 + 1)).collect();
        assert!(sanitize(&too_many).is_err());
    }

    #[test]
    fn known_services_resolve_and_unknown_ones_do_not() {
        assert_eq!(service_name(443), Some("HTTPS"));
        assert_eq!(service_name(3389), Some("RDP"));
        assert_eq!(service_name(5901), Some("VNC"));
        assert_eq!(service_name(5985), Some("WinRM"));
        assert_eq!(service_name(9100), Some("Print"));
        assert_eq!(service_name(5060), Some("SIP"));
        assert_eq!(service_name(64999), None);
    }

    #[test]
    fn the_catalog_matches_the_service_table() {
        let catalog = catalog();
        assert!(catalog.len() > 60, "{} entries", catalog.len());
        assert!(catalog.iter().all(|(p, _)| service_name(*p).is_some()));
        assert!(!catalog.iter().any(|(p, _)| *p == 64999));
        let https = catalog.iter().find(|(p, _)| *p == 443).unwrap();
        assert_eq!(https.1, "HTTPS");
        // Sorted, so the settings list reads in port order.
        assert!(catalog.windows(2).all(|w| w[0].0 < w[1].0));
    }
}
