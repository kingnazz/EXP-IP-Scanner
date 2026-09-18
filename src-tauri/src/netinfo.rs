//! Local interface detection and ranking.
//!
//! This is what makes "open the app and press Scan" true: the machine's own
//! address and netmask become the network to sweep, with no typing.
//!
//! ArcScan's `netinfo` enumerated interfaces and sorted them by address family
//! and prefix. A technician's laptop needs more than that. It routinely carries
//! a Hyper-V default switch, a Docker bridge, a VMware host-only adapter, a VPN
//! client and two physical NICs at once, and only one of those is the customer
//! network. So interfaces are classified and scored here, the best one becomes
//! the default, and none of them are hidden -- a technician sometimes really
//! does mean the VPN adapter or the USB NIC, and a tool that silently removed
//! it would be worse than one that merely ranked it lower.

use std::collections::HashSet;
use std::net::Ipv4Addr;

use serde::Serialize;

/// What kind of adapter an interface appears to be, inferred from its name.
///
/// A guess, and treated as one: it decides presentation order and nothing else.
/// Every detected interface remains selectable whatever it is classified as.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InterfaceKind {
    Ethernet,
    Wireless,
    /// A tunnel: corporate VPN clients, WireGuard, ZeroTier, Tailscale, PPP.
    Vpn,
    /// Hypervisor and container plumbing: Hyper-V, VMware, VirtualBox, Docker,
    /// WSL, virtual switches, Bluetooth PAN.
    Virtual,
    /// A real interface whose name says nothing useful.
    Other,
}

impl InterfaceKind {
    /// The word shown in the network context strip, e.g. `Ethernet · 10.0.0.5 · /24`.
    pub fn label(self) -> &'static str {
        match self {
            InterfaceKind::Ethernet => "Ethernet",
            InterfaceKind::Wireless => "Wi-Fi",
            InterfaceKind::Vpn => "VPN",
            InterfaceKind::Virtual => "Virtual",
            InterfaceKind::Other => "Network",
        }
    }
}

/// One usable IPv4 interface, ready to be offered as a scan target.
#[derive(Debug, Clone, Serialize)]
pub struct LocalNetwork {
    /// The adapter's name as the operating system reports it, e.g. `Ethernet 2`
    /// or `vEthernet (Default Switch)`.
    pub interface: String,
    /// This machine's own address on the interface.
    pub ip: String,
    /// Prefix length derived from the netmask.
    pub prefix: u8,
    /// The interface's own network in CIDR form.
    pub cidr: String,
    /// The network the Scan button should actually target. Equal to `cidr` for
    /// ordinary subnets; narrowed to the containing /24 on very large flat
    /// networks, where sweeping the whole thing is never what was meant.
    pub suggested_cidr: String,
    /// How many addresses `suggested_cidr` covers.
    pub suggested_hosts: u64,
    pub kind: InterfaceKind,
    /// Short type word for the context strip.
    pub kind_label: String,
    pub is_private: bool,
    /// True for the one interface picked as the default target.
    pub recommended: bool,
}

/// Prefix at or below which the interface's own network is too large to be a
/// sensible default target, so the containing /24 is suggested instead.
///
/// A /20 is 4,094 addresses and still a reasonable sweep. A flat /16 or /12 --
/// which plenty of corporate networks are -- is not what a technician means by
/// "scan this network", and making them wait to find that out would be a poor
/// first impression. The real prefix is still shown, and the target field is
/// editable, so nothing is taken away.
const LARGEST_AUTO_PREFIX: u8 = 20;

/// Name fragments that identify each kind of adapter.
///
/// Matched against a lowercased interface name. Order matters: the virtual and
/// VPN lists are consulted before the physical ones, because `vEthernet
/// (Default Switch)` contains "ethernet" and is emphatically not the customer's
/// Ethernet port.
const VIRTUAL_MARKERS: [&str; 20] = [
    "vethernet",
    "hyper-v",
    "hyperv",
    "vmware",
    "vmnet",
    "virtualbox",
    "vboxnet",
    "docker",
    "br-",
    "veth",
    "wsl",
    "virtual switch",
    "loopback",
    "teredo",
    "isatap",
    "npcap",
    "bluetooth",
    "hamachi",
    "nat network",
    "host-only",
];

const VPN_MARKERS: [&str; 17] = [
    "vpn",
    "wireguard",
    "wg0",
    "openvpn",
    "tailscale",
    "zerotier",
    "anyconnect",
    "globalprotect",
    "forticlient",
    "fortissl",
    "pulse secure",
    "sonicwall",
    "nordlynx",
    "tunnel",
    "tap-windows",
    "ppp",
    "utun",
];

const WIRELESS_MARKERS: [&str; 6] = ["wi-fi", "wifi", "wlan", "wireless", "wlp", "airport"];

const ETHERNET_MARKERS: [&str; 7] = [
    "ethernet",
    "local area connection",
    "eth",
    "enp",
    "eno",
    "ens",
    "en0",
];

/// Classify an interface from its name.
pub fn classify(name: &str) -> InterfaceKind {
    let n = name.to_ascii_lowercase();

    // Virtual and tunnel names are checked first: several of them embed a
    // physical adapter word and would otherwise be mistaken for one.
    if VIRTUAL_MARKERS.iter().any(|m| n.contains(m)) {
        return InterfaceKind::Virtual;
    }
    if VPN_MARKERS.iter().any(|m| n.contains(m)) {
        return InterfaceKind::Vpn;
    }
    if WIRELESS_MARKERS.iter().any(|m| n.contains(m)) {
        return InterfaceKind::Wireless;
    }
    if ETHERNET_MARKERS.iter().any(|m| n.contains(m)) {
        return InterfaceKind::Ethernet;
    }
    InterfaceKind::Other
}

/// How good a default scan target an interface is. Higher wins.
///
/// Kind dominates, because a wired or wireless NIC holding a private address is
/// the customer network in almost every case a technician meets. A private
/// address is worth more than a public one for the same reason: EXP IP Scanner
/// is pointed at LANs.
fn score(kind: InterfaceKind, ip: Ipv4Addr, prefix: u8) -> i32 {
    let base = match kind {
        InterfaceKind::Ethernet => 1_000,
        InterfaceKind::Wireless => 900,
        InterfaceKind::Other => 500,
        // Selectable and clearly listed, but never the automatic choice: a
        // tunnel's "subnet" is usually a /32 host route or a range whose other
        // members are not reachable by ARP at all.
        InterfaceKind::Vpn => 200,
        InterfaceKind::Virtual => 50,
    };
    let privacy = if ip.is_private() { 200 } else { 0 };
    // Among equals, prefer the more specific subnet: a /24 is a network someone
    // administers, a /8 is a routing artefact.
    let specificity = i32::from(prefix);
    base + privacy + specificity
}

/// The network to put in the target field for an interface.
fn suggest(ip: Ipv4Addr, prefix: u8) -> (String, u64) {
    let use_prefix = if prefix < LARGEST_AUTO_PREFIX {
        24
    } else {
        prefix
    };
    (
        crate::ipparse::network_cidr(ip, use_prefix),
        crate::ipparse::hosts_in_prefix(use_prefix),
    )
}

/// Enumerate usable IPv4 interfaces, best default first.
///
/// Loopback, link-local (169.254/16, i.e. a failed DHCP lease) and unspecified
/// addresses are dropped: none of them is a network anyone can scan. Host-only
/// prefixes (/31, /32) and /0 are dropped too, because there is no subnet there
/// to sweep. Everything that survives is returned and is selectable.
pub fn detect() -> Vec<LocalNetwork> {
    let ifaces = match if_addrs::get_if_addrs() {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let mut nets: Vec<(i32, LocalNetwork)> = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();

    for iface in ifaces {
        let if_addrs::IfAddr::V4(v4) = iface.addr else {
            continue;
        };
        let ip = v4.ip;
        if ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() {
            continue;
        }
        let mask = u32::from(v4.netmask);
        // A netmask has to be a run of ones; anything else is not a mask this
        // can reason about.
        if mask != 0 && (!mask).wrapping_add(1).count_ones() > 1 {
            continue;
        }
        let prefix = mask.count_ones() as u8;
        if prefix == 0 || prefix > 30 {
            continue;
        }

        let cidr = crate::ipparse::network_cidr(ip, prefix);
        // The same network can appear twice (two addresses on one adapter, or a
        // bridge mirroring its member). Keyed by adapter *and* network, so a
        // machine genuinely holding two NICs on the same subnet still shows both.
        if !seen.insert((iface.name.clone(), cidr.clone())) {
            continue;
        }

        let kind = classify(&iface.name);
        let (suggested_cidr, suggested_hosts) = suggest(ip, prefix);
        nets.push((
            score(kind, ip, prefix),
            LocalNetwork {
                interface: iface.name.clone(),
                ip: ip.to_string(),
                prefix,
                cidr,
                suggested_cidr,
                suggested_hosts,
                kind,
                kind_label: kind.label().to_string(),
                is_private: ip.is_private(),
                recommended: false,
            },
        ));
    }

    // Highest score first; ties broken by adapter name so the order a
    // technician sees does not shuffle between launches.
    nets.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.interface.cmp(&b.1.interface))
    });

    let mut out: Vec<LocalNetwork> = nets.into_iter().map(|(_, net)| net).collect();
    if let Some(first) = out.first_mut() {
        first.recommended = true;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn net(name: &str, ip: &str, prefix: u8) -> LocalNetwork {
        let addr: Ipv4Addr = ip.parse().unwrap();
        let kind = classify(name);
        let (suggested_cidr, suggested_hosts) = suggest(addr, prefix);
        LocalNetwork {
            interface: name.to_string(),
            ip: ip.to_string(),
            prefix,
            cidr: crate::ipparse::network_cidr(addr, prefix),
            suggested_cidr,
            suggested_hosts,
            kind,
            kind_label: kind.label().to_string(),
            is_private: addr.is_private(),
            recommended: false,
        }
    }

    /// The ranking from `detect`, applied to a fixed set of interfaces so the
    /// decision can be tested without the machine the test runs on.
    fn rank(mut nets: Vec<LocalNetwork>) -> Vec<LocalNetwork> {
        nets.sort_by(|a, b| {
            let sa = score(a.kind, a.ip.parse().unwrap(), a.prefix);
            let sb = score(b.kind, b.ip.parse().unwrap(), b.prefix);
            sb.cmp(&sa).then_with(|| a.interface.cmp(&b.interface))
        });
        if let Some(first) = nets.first_mut() {
            first.recommended = true;
        }
        nets
    }

    #[test]
    fn classifies_the_adapters_a_technician_laptop_actually_has() {
        assert_eq!(classify("Ethernet"), InterfaceKind::Ethernet);
        assert_eq!(classify("Ethernet 2"), InterfaceKind::Ethernet);
        assert_eq!(classify("Local Area Connection"), InterfaceKind::Ethernet);
        assert_eq!(classify("eth0"), InterfaceKind::Ethernet);

        assert_eq!(classify("Wi-Fi"), InterfaceKind::Wireless);
        assert_eq!(classify("WiFi 2"), InterfaceKind::Wireless);
        assert_eq!(classify("wlan0"), InterfaceKind::Wireless);
        assert_eq!(
            classify("Intel(R) Wireless-AC 9560"),
            InterfaceKind::Wireless
        );

        // The trap: these all contain a physical adapter word.
        assert_eq!(
            classify("vEthernet (Default Switch)"),
            InterfaceKind::Virtual
        );
        assert_eq!(classify("vEthernet (WSL)"), InterfaceKind::Virtual);
        assert_eq!(
            classify("VMware Network Adapter VMnet8"),
            InterfaceKind::Virtual
        );
        assert_eq!(classify("Hyper-V Virtual Switch"), InterfaceKind::Virtual);
        assert_eq!(classify("docker0"), InterfaceKind::Virtual);
        assert_eq!(
            classify("VirtualBox Host-Only Network"),
            InterfaceKind::Virtual
        );
        assert_eq!(
            classify("Bluetooth Network Connection"),
            InterfaceKind::Virtual
        );

        assert_eq!(classify("Cisco AnyConnect VA"), InterfaceKind::Vpn);
        assert_eq!(classify("GlobalProtect"), InterfaceKind::Vpn);
        assert_eq!(classify("WireGuard Tunnel"), InterfaceKind::Vpn);
        assert_eq!(classify("Tailscale"), InterfaceKind::Vpn);
        assert_eq!(classify("TAP-Windows Adapter V9"), InterfaceKind::Vpn);

        assert_eq!(classify("Realtek Gaming 2.5GbE"), InterfaceKind::Other);
    }

    #[test]
    fn a_physical_adapter_beats_every_virtual_one() {
        let ranked = rank(vec![
            net("vEthernet (Default Switch)", "172.26.32.1", 20),
            net("VMware Network Adapter VMnet1", "192.168.181.1", 24),
            net("Ethernet", "192.168.10.42", 24),
            net("docker0", "172.17.0.1", 16),
        ]);
        assert_eq!(ranked[0].interface, "Ethernet");
        assert!(ranked[0].recommended);
        // Nothing was removed: the technician can still pick the virtual ones.
        assert_eq!(ranked.len(), 4);
        assert!(ranked[1..].iter().all(|n| !n.recommended));
    }

    #[test]
    fn wired_beats_wireless_when_both_are_connected() {
        let ranked = rank(vec![
            net("Wi-Fi", "192.168.1.50", 24),
            net("Ethernet", "192.168.10.42", 24),
        ]);
        assert_eq!(ranked[0].interface, "Ethernet");
        assert_eq!(ranked[1].interface, "Wi-Fi");
    }

    #[test]
    fn wireless_is_the_default_when_it_is_the_only_physical_adapter() {
        let ranked = rank(vec![
            net("vEthernet (WSL)", "172.28.0.1", 20),
            net("Wi-Fi", "10.20.30.18", 24),
        ]);
        assert_eq!(ranked[0].interface, "Wi-Fi");
        assert_eq!(ranked[0].suggested_cidr, "10.20.30.0/24");
    }

    #[test]
    fn a_usb_nic_is_offered_ahead_of_a_vpn_tunnel() {
        // A USB dock reports as another Ethernet adapter, which is exactly the
        // interface someone plugging into a customer switch means.
        let ranked = rank(vec![
            net("Cisco AnyConnect VA", "10.99.0.7", 24),
            net("Ethernet 3", "192.168.8.21", 24),
        ]);
        assert_eq!(ranked[0].interface, "Ethernet 3");
        assert_eq!(ranked[1].kind, InterfaceKind::Vpn);
    }

    #[test]
    fn a_private_address_outranks_a_public_one_on_the_same_kind() {
        let ranked = rank(vec![
            net("Ethernet 2", "203.0.113.20", 24),
            net("Ethernet 1", "192.168.4.20", 24),
        ]);
        assert_eq!(ranked[0].interface, "Ethernet 1");
    }

    #[test]
    fn a_more_specific_subnet_wins_between_otherwise_equal_adapters() {
        let ranked = rank(vec![
            net("Ethernet 2", "10.0.0.20", 16),
            net("Ethernet 1", "10.1.0.20", 24),
        ]);
        assert_eq!(ranked[0].interface, "Ethernet 1");
    }

    #[test]
    fn ties_are_broken_by_name_so_the_order_is_stable() {
        let a = rank(vec![
            net("Ethernet 2", "192.168.2.10", 24),
            net("Ethernet 1", "192.168.1.10", 24),
        ]);
        let b = rank(vec![
            net("Ethernet 1", "192.168.1.10", 24),
            net("Ethernet 2", "192.168.2.10", 24),
        ]);
        assert_eq!(a[0].interface, b[0].interface);
        assert_eq!(a[0].interface, "Ethernet 1");
    }

    #[test]
    fn an_ordinary_subnet_is_suggested_exactly_as_it_is() {
        let n = net("Ethernet", "192.168.50.37", 24);
        assert_eq!(n.cidr, "192.168.50.0/24");
        assert_eq!(n.suggested_cidr, "192.168.50.0/24");
        assert_eq!(n.suggested_hosts, 254);

        let n = net("Ethernet", "172.16.5.200", 22);
        assert_eq!(n.suggested_cidr, "172.16.4.0/22");
        assert_eq!(n.suggested_hosts, 1022);
    }

    #[test]
    fn a_flat_corporate_network_is_narrowed_to_the_local_slash_24() {
        // The interface really is a /16, and the picker still says so. The Scan
        // button targets the /24 the machine is actually sitting in.
        let n = net("Ethernet", "10.44.7.31", 16);
        assert_eq!(n.prefix, 16);
        assert_eq!(n.cidr, "10.44.0.0/16");
        assert_eq!(n.suggested_cidr, "10.44.7.0/24");
        assert_eq!(n.suggested_hosts, 254);

        let n = net("Ethernet", "10.8.1.5", 8);
        assert_eq!(n.suggested_cidr, "10.8.1.0/24");
    }

    #[test]
    fn the_suggested_target_is_always_a_scannable_target() {
        for (ip, prefix) in [
            ("192.168.1.10", 24u8),
            ("10.44.7.31", 16),
            ("172.16.5.200", 22),
            ("10.0.0.5", 8),
            ("192.168.1.10", 30),
            ("192.168.1.10", 20),
        ] {
            let n = net("Ethernet", ip, prefix);
            let hosts = crate::ipparse::parse_target(&n.suggested_cidr)
                .unwrap_or_else(|e| panic!("/{prefix} suggested an unscannable target: {e}"));
            assert_eq!(hosts.len() as u64, n.suggested_hosts);
        }
    }

    #[test]
    fn detect_runs_and_reports_at_most_one_recommendation() {
        // Whatever this machine has, the invariants hold.
        let nets = detect();
        assert!(nets.iter().filter(|n| n.recommended).count() <= 1);
        for n in &nets {
            assert!(n.prefix >= 1 && n.prefix <= 30, "{n:?}");
            assert!(
                crate::ipparse::parse_target(&n.suggested_cidr).is_ok(),
                "{n:?}"
            );
            let ip: Ipv4Addr = n.ip.parse().expect("a reported address parses");
            assert!(!ip.is_loopback() && !ip.is_link_local());
        }
        if let Some(first) = nets.first() {
            assert!(first.recommended, "the first interface is the default");
        }
    }
}
