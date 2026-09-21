//! Scan-target parsing.
//!
//! Adapted from ArcScan's `ipparse` module, which is the proven implementation
//! of exactly this problem. Accepts CIDR (`192.168.1.0/24`), dashed ranges
//! (`192.168.1.1-254` or `10.0.0.1-10.0.0.50`) and single addresses. All target
//! parsing lives here so the backend validates what it is asked to scan
//! independently of whatever the interface believed it sent.

use std::net::Ipv4Addr;

/// Upper bound on how many addresses one scan may enumerate.
///
/// A /16 is the practical ceiling for a LAN sweep. Anything larger is a typo
/// rather than a request, and would spend memory and minutes proving it.
pub const MAX_HOSTS: usize = 65_536;

/// Parse a target into the concrete list of addresses to probe.
///
/// The error strings are written to be shown to a consultant as they are, which
/// is why they name the offending token and say what was expected.
pub fn parse_target(input: &str) -> Result<Vec<Ipv4Addr>, String> {
    let s = input.trim();
    if s.is_empty() {
        return Err("Enter a network to scan, for example 192.168.1.0/24.".into());
    }

    let hosts = if let Some((base, prefix)) = s.split_once('/') {
        parse_cidr(base.trim(), prefix.trim())?
    } else if let Some((a, b)) = s.split_once('-') {
        parse_range(a.trim(), b.trim())?
    } else {
        vec![parse_ipv4(s)?]
    };

    if hosts.is_empty() {
        return Err("That target contains no addresses to scan.".into());
    }
    if hosts.len() > MAX_HOSTS {
        return Err(format!(
            "That target covers {} addresses, more than the {} address limit. Scan a smaller range.",
            hosts.len(),
            MAX_HOSTS
        ));
    }
    Ok(hosts)
}

/// The network an address belongs to, in CIDR form, ready to drop into the
/// target field. This is the whole of "open the app and press Scan": the
/// machine's own address and mask become the network to sweep.
pub fn network_cidr(ip: Ipv4Addr, prefix: u8) -> String {
    let mask = prefix_mask(u32::from(prefix));
    format!("{}/{}", Ipv4Addr::from(u32::from(ip) & mask), prefix)
}

/// How many usable host addresses a prefix length covers, matching what
/// [`parse_target`] would actually enumerate for that CIDR.
pub fn hosts_in_prefix(prefix: u8) -> u64 {
    let bits = u32::from(prefix.min(32));
    let size = 1u64 << (32 - bits);
    // /31 and /32 have no network/broadcast split, so every address is usable.
    if bits >= 31 {
        size
    } else {
        size - 2
    }
}

fn prefix_mask(bits: u32) -> u32 {
    if bits == 0 {
        0
    } else {
        u32::MAX << (32 - bits.min(32))
    }
}

fn parse_ipv4(s: &str) -> Result<Ipv4Addr, String> {
    s.parse::<Ipv4Addr>()
        .map_err(|_| format!("`{s}` is not a valid IPv4 address."))
}

/// Resolve the end of a dashed range, which a consultant writes either as a
/// full address (`192.168.1.254`) or as a bare last octet (`254`).
fn range_end(start: Ipv4Addr, b: &str) -> Result<Ipv4Addr, String> {
    if b.contains('.') {
        return parse_ipv4(b);
    }
    let last: u8 = b
        .parse()
        .map_err(|_| format!("`{b}` is not a valid range end. Use an address or 0-255."))?;
    let o = start.octets();
    Ok(Ipv4Addr::new(o[0], o[1], o[2], last))
}

fn parse_cidr(base: &str, prefix: &str) -> Result<Vec<Ipv4Addr>, String> {
    let ip = parse_ipv4(base)?;
    let bits: u32 = prefix
        .parse()
        .map_err(|_| format!("`/{prefix}` is not a valid network size."))?;
    if bits > 32 {
        return Err("A network size must be between /0 and /32.".into());
    }
    let mask = prefix_mask(bits);
    let network = u32::from(ip) & mask;
    let broadcast = network | !mask;

    // For /31 and /32 there is no network/broadcast split, so every address is
    // a host address.
    let (first, last) = if bits >= 31 {
        (network, broadcast)
    } else {
        (network + 1, broadcast.saturating_sub(1))
    };

    let count = (last as u64 - first as u64 + 1) as usize;
    if count > MAX_HOSTS {
        return Err(format!(
            "/{bits} covers {count} addresses, more than the {MAX_HOSTS} address limit. \
             Scan a smaller range."
        ));
    }
    Ok((first..=last).map(Ipv4Addr::from).collect())
}

fn parse_range(a: &str, b: &str) -> Result<Vec<Ipv4Addr>, String> {
    let start = parse_ipv4(a)?;
    let end = range_end(start, b)?;

    let s = u32::from(start);
    let e = u32::from(end);
    if e < s {
        return Err("The end of that range is lower than the start.".into());
    }
    let count = (e as u64 - s as u64 + 1) as usize;
    if count > MAX_HOSTS {
        return Err(format!(
            "That range covers {count} addresses, more than the {MAX_HOSTS} address limit. \
             Scan a smaller range."
        ));
    }
    Ok((s..=e).map(Ipv4Addr::from).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_ip() {
        let hosts = parse_target("192.168.1.5").unwrap();
        assert_eq!(hosts, vec![Ipv4Addr::new(192, 168, 1, 5)]);
    }

    #[test]
    fn cidr_24_excludes_network_and_broadcast() {
        let h = parse_target("192.168.1.0/24").unwrap();
        assert_eq!(h.len(), 254);
        assert_eq!(h[0], Ipv4Addr::new(192, 168, 1, 1));
        assert_eq!(h[253], Ipv4Addr::new(192, 168, 1, 254));
    }

    #[test]
    fn cidr_normalizes_any_address_inside_the_block() {
        // A consultant pastes their own address with a mask; that is the network.
        let from_host = parse_target("192.168.1.37/24").unwrap();
        let from_network = parse_target("192.168.1.0/24").unwrap();
        assert_eq!(from_host, from_network);
    }

    #[test]
    fn cidr_31_and_32_keep_every_address() {
        assert_eq!(parse_target("10.0.0.9/32").unwrap().len(), 1);
        assert_eq!(parse_target("10.0.0.8/31").unwrap().len(), 2);
    }

    #[test]
    fn cidr_23_and_22_are_within_the_limit() {
        assert_eq!(parse_target("10.4.0.0/23").unwrap().len(), 510);
        assert_eq!(parse_target("10.4.0.0/22").unwrap().len(), 1022);
    }

    #[test]
    fn dashed_full_range() {
        let h = parse_target("10.0.0.1-10.0.0.50").unwrap();
        assert_eq!(h.len(), 50);
        assert_eq!(h[49], Ipv4Addr::new(10, 0, 0, 50));
    }

    #[test]
    fn dashed_short_range() {
        let h = parse_target("192.168.1.1-254").unwrap();
        assert_eq!(h.len(), 254);
        assert_eq!(h[0], Ipv4Addr::new(192, 168, 1, 1));
        assert_eq!(h[253], Ipv4Addr::new(192, 168, 1, 254));
    }

    #[test]
    fn whitespace_is_tolerated() {
        assert_eq!(parse_target("  192.168.1.0/24  ").unwrap().len(), 254);
        assert_eq!(parse_target("10.0.0.1 - 10.0.0.4").unwrap().len(), 4);
    }

    #[test]
    fn rejects_reversed_range() {
        assert!(parse_target("10.0.0.50-10.0.0.1").is_err());
    }

    #[test]
    fn rejects_oversized_targets() {
        assert!(parse_target("10.0.0.0/8").is_err());
        assert!(parse_target("10.0.0.0/15").is_err());
        // A /16 is exactly the limit and is allowed.
        assert_eq!(parse_target("10.0.0.0/16").unwrap().len(), 65_534);
    }

    #[test]
    fn rejects_malformed_targets_with_readable_errors() {
        for bad in [
            "",
            "   ",
            "not-an-ip",
            "192.168.1",
            "192.168.1.256",
            "192.168.1.0/33",
            "192.168.1.0/abc",
            "192.168.1.1-nope",
            "192.168.1.1-999",
        ] {
            let err = parse_target(bad).unwrap_err();
            assert!(!err.is_empty(), "no message for {bad:?}");
            assert!(
                !err.contains("ParseIntError") && !err.contains("AddrParseError"),
                "leaked an internal error for {bad:?}: {err}"
            );
        }
    }

    #[test]
    fn network_cidr_derives_the_subnet_from_an_address_and_mask() {
        assert_eq!(
            network_cidr(Ipv4Addr::new(192, 168, 50, 37), 24),
            "192.168.50.0/24"
        );
        assert_eq!(
            network_cidr(Ipv4Addr::new(10, 20, 30, 18), 24),
            "10.20.30.0/24"
        );
        assert_eq!(
            network_cidr(Ipv4Addr::new(172, 16, 5, 200), 22),
            "172.16.4.0/22"
        );
        assert_eq!(
            network_cidr(Ipv4Addr::new(192, 168, 1, 9), 16),
            "192.168.0.0/16"
        );
    }

    #[test]
    fn host_counts_match_what_a_scan_would_enumerate() {
        for prefix in [22u8, 23, 24, 25, 30, 31, 32] {
            let cidr = network_cidr(Ipv4Addr::new(10, 8, 4, 1), prefix);
            assert_eq!(
                hosts_in_prefix(prefix) as usize,
                parse_target(&cidr).unwrap().len(),
                "/{prefix} disagrees"
            );
        }
    }
}
