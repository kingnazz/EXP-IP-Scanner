//! Console companion for ScreenConnect Backstage and other limited shells.
//!
//! Backstage uses a custom Windows shell and does not reliably host WebView
//! applications. This companion deliberately bypasses Tauri/WebView2 and calls
//! the exact same Rust discovery engine as the desktop application.

use std::env;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tokio::sync::mpsc;

use crate::{netinfo, ports, scanner};

const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Default, PartialEq, Eq)]
struct Args {
    target: Option<String>,
    port_spec: Option<String>,
    no_services: bool,
    csv: Option<PathBuf>,
    json: bool,
    help: bool,
}

#[derive(Debug, Clone, Serialize)]
struct NetworkContext {
    adapter: String,
    local_ip: String,
    gateway: Option<String>,
    suggested_target: String,
}

#[derive(Debug, Serialize)]
struct BackstageOutput {
    version: &'static str,
    mode: &'static str,
    network: Option<NetworkContext>,
    scan: scanner::ScanResult,
}

pub fn run() -> i32 {
    let args = match parse_args(env::args().skip(1)) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("EXP IP Scanner Backstage: {message}");
            eprintln!("Use --help for usage.");
            return 2;
        }
    };

    if args.help {
        print_help();
        return 0;
    }

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("EXP IP Scanner Backstage: could not start the scanner runtime: {error}");
            return 2;
        }
    };

    match runtime.block_on(run_async(args)) {
        Ok(()) => 0,
        Err(message) => {
            eprintln!("EXP IP Scanner Backstage: {message}");
            1
        }
    }
}

fn parse_args<I>(args: I) -> Result<Args, String>
where
    I: IntoIterator<Item = String>,
{
    let mut parsed = Args::default();
    let mut iter = args.into_iter();

    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-h" | "--help" => parsed.help = true,
            "--target" => {
                parsed.target = Some(next_value(&mut iter, "--target")?);
            }
            "--ports" => {
                parsed.port_spec = Some(next_value(&mut iter, "--ports")?);
            }
            "--no-services" => parsed.no_services = true,
            "--csv" => {
                parsed.csv = Some(PathBuf::from(next_value(&mut iter, "--csv")?));
            }
            "--json" => parsed.json = true,
            _ if arg.starts_with('-') => return Err(format!("unknown option {arg}")),
            _ if parsed.target.is_none() => parsed.target = Some(arg),
            _ => return Err(format!("unexpected argument {arg}")),
        }
    }

    Ok(parsed)
}

fn next_value<I>(iter: &mut I, flag: &str) -> Result<String, String>
where
    I: Iterator<Item = String>,
{
    iter.next()
        .filter(|value| !value.trim().is_empty() && !value.starts_with('-'))
        .ok_or_else(|| format!("{flag} needs a value"))
}

async fn run_async(args: Args) -> Result<(), String> {
    let networks = netinfo::detect().await;
    let selected = networks
        .iter()
        .find(|network| network.recommended)
        .or_else(|| networks.first())
        .cloned();

    let target = match args.target.clone() {
        Some(target) => target,
        None => selected
            .as_ref()
            .map(|network| network.suggested_cidr.clone())
            .ok_or_else(|| {
                "no usable IPv4 network was detected; pass one explicitly with --target 192.168.1.0/24"
                    .to_string()
            })?,
    };

    let requested_ports = match args.port_spec.as_deref() {
        Some(spec) => ports::parse_spec(spec)?,
        None => Vec::new(),
    };

    let limits = scanner::ScanLimits::default();
    let options = scanner::ScanOptions {
        target: target.clone(),
        ports: requested_ports,
        timeout_ms: 900,
        concurrency: limits.host_concurrency,
        tcp_concurrency: Some(limits.tcp_concurrency),
        ping_concurrency: Some(limits.ping_concurrency),
        resolve_hostnames: true,
        scan_services: !args.no_services,
    };

    let plan = scanner::plan(&options)?;
    let network_context = selected.as_ref().map(|network| NetworkContext {
        adapter: network.interface.clone(),
        local_ip: network.ip.clone(),
        gateway: network.gateway.clone(),
        suggested_target: network.suggested_cidr.clone(),
    });

    if !args.json {
        print_banner(network_context.as_ref(), &target, &plan, args.no_services);
    }

    let scan_id = scanner::next_scan_id();
    let (tx, mut rx) = mpsc::channel(scanner::EVENT_CHANNEL_CAPACITY);
    let scan_task = tokio::spawn(scanner::run(options, scan_id, Some(tx)));

    let mut last_progress_bucket = 0usize;
    while let Some(event) = rx.recv().await {
        if args.json {
            continue;
        }

        match event {
            scanner::ScanEvent::HostDiscovered { host, .. } => {
                println!("  found {}", host.ip);
            }
            scanner::ScanEvent::Progress(progress) if progress.total > 0 => {
                let pct = progress.done.saturating_mul(100) / progress.total;
                let bucket = pct / 25;
                if bucket > last_progress_bucket && pct < 100 {
                    last_progress_bucket = bucket;
                    println!("  progress {:>3}%  {} found", pct, progress.found);
                }
            }
            _ => {}
        }
    }

    let mut result = scan_task
        .await
        .map_err(|error| format!("scanner task failed: {error}"))??;

    result.hosts.sort_by_key(|host| {
        host.ip
            .parse::<Ipv4Addr>()
            .map(u32::from)
            .unwrap_or(u32::MAX)
    });

    if let Some(path) = args.csv.as_deref() {
        write_csv(path, &result)?;
        if !args.json {
            println!();
            println!("CSV saved to {}", path.display());
        }
    }

    if args.json {
        let output = BackstageOutput {
            version: VERSION,
            mode: "backstage",
            network: network_context,
            scan: result,
        };
        println!(
            "{}",
            serde_json::to_string_pretty(&output)
                .map_err(|error| format!("could not serialize JSON output: {error}"))?
        );
    } else {
        print_results(&result);
    }

    Ok(())
}

fn print_banner(
    network: Option<&NetworkContext>,
    target: &str,
    plan: &scanner::ScanPlan,
    no_services: bool,
) {
    println!("EXP IP Scanner Backstage v{VERSION}");
    println!("Console mode for ScreenConnect Backstage - no WebView2 required");
    println!();

    if let Some(network) = network {
        println!("Adapter : {}", network.adapter);
        println!("Local IP: {}", network.local_ip);
        println!("Gateway : {}", network.gateway.as_deref().unwrap_or("None"));
    }
    println!("Target  : {target}");
    println!(
        "Scan    : {} addresses, {} {}",
        plan.hosts.len(),
        plan.ports.len(),
        if no_services {
            "liveness ports"
        } else {
            "service ports"
        }
    );
    if let Some(warning) = &plan.warning {
        println!("Warning : {warning}");
    }
    println!();
    println!("Scanning...");
}

fn print_results(result: &scanner::ScanResult) {
    println!();
    println!(
        "{} device{} found in {:.1}s",
        result.hosts.len(),
        if result.hosts.len() == 1 { "" } else { "s" },
        result.duration_ms as f64 / 1000.0
    );
    println!();

    println!(
        "{:<15} {:<26} {:<17} {:<22} {:>8}  SERVICES",
        "IP", "HOSTNAME", "MAC", "VENDOR", "LAT(ms)"
    );
    println!("{}", "-".repeat(112));

    for host in &result.hosts {
        let hostname = clip(host.hostname.as_deref().unwrap_or("-"), 26);
        let mac = host.mac.as_deref().unwrap_or("-");
        let vendor = clip(host.vendor.as_deref().unwrap_or("-"), 22);
        let latency = host
            .latency_ms
            .map(|value| format!("{value:.1}"))
            .unwrap_or_else(|| "-".to_string());
        let services = format_services(&host.open_ports);

        println!(
            "{:<15} {:<26} {:<17} {:<22} {:>8}  {}",
            host.ip, hostname, mac, vendor, latency, services
        );
    }

    if result.hosts.is_empty() {
        println!("No responding devices were found.");
    }
}

fn format_services(open_ports: &[u16]) -> String {
    if open_ports.is_empty() {
        return "-".to_string();
    }

    open_ports
        .iter()
        .map(|port| match ports::service_name(*port) {
            Some(name) => format!("{port}/{name}"),
            None => port.to_string(),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn clip(value: &str, width: usize) -> String {
    let count = value.chars().count();
    if count <= width {
        return value.to_string();
    }
    if width <= 1 {
        return "~".to_string();
    }
    let mut out = value.chars().take(width - 1).collect::<String>();
    out.push('~');
    out
}

fn write_csv(path: &Path, result: &scanner::ScanResult) -> Result<(), String> {
    let file = File::create(path)
        .map_err(|error| format!("could not create {}: {error}", path.display()))?;
    let mut writer = BufWriter::new(file);
    writeln!(
        writer,
        "IP Address,Hostname,MAC Address,Manufacturer,Latency ms,Open Services"
    )
    .map_err(|error| format!("could not write {}: {error}", path.display()))?;

    for host in &result.hosts {
        let services = format_services(&host.open_ports);
        let latency = host
            .latency_ms
            .map(|value| format!("{value:.1}"))
            .unwrap_or_default();
        let fields = [
            host.ip.as_str(),
            host.hostname.as_deref().unwrap_or(""),
            host.mac.as_deref().unwrap_or(""),
            host.vendor.as_deref().unwrap_or(""),
            latency.as_str(),
            services.as_str(),
        ];
        let line = fields
            .iter()
            .map(|field| csv_field(field))
            .collect::<Vec<_>>()
            .join(",");
        writeln!(writer, "{line}")
            .map_err(|error| format!("could not write {}: {error}", path.display()))?;
    }

    writer
        .flush()
        .map_err(|error| format!("could not finish {}: {error}", path.display()))
}

fn csv_field(value: &str) -> String {
    if value
        .chars()
        .any(|character| matches!(character, ',' | '"' | '\n' | '\r'))
    {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn print_help() {
    println!(
        "EXP IP Scanner Backstage v{VERSION}\n\n\
Usage:\n  EXP-IP-Scanner-Backstage.exe [target] [options]\n\n\
Options:\n  --target <CIDR>      Scan a CIDR, IP, or supported range.\n                       Defaults to the recommended local subnet.\n  --ports <spec>       Ports such as 22,80,443 or 8000-8100.\n  --no-services        Do liveness discovery without the full service set.\n  --csv <path>         Save the finished device table as CSV.\n  --json               Emit machine-readable JSON instead of the table.\n  -h, --help           Show this help.\n\n\
Examples:\n  EXP-IP-Scanner-Backstage.exe\n  EXP-IP-Scanner-Backstage.exe --target 192.168.1.0/24\n  EXP-IP-Scanner-Backstage.exe 10.0.0.0/24 --ports 22,80,443,445,3389\n  EXP-IP-Scanner-Backstage.exe --csv scan.csv\n  EXP-IP-Scanner-Backstage.exe --target 10.20.0.0/24 --json"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(values: &[&str]) -> Args {
        parse_args(values.iter().map(|value| value.to_string())).unwrap()
    }

    #[test]
    fn no_arguments_means_auto_detect() {
        assert_eq!(parse(&[]), Args::default());
    }

    #[test]
    fn accepts_a_bare_target_and_backstage_options() {
        assert_eq!(
            parse(&[
                "192.168.50.0/24",
                "--ports",
                "22,80,443",
                "--csv",
                "scan.csv",
                "--json",
            ]),
            Args {
                target: Some("192.168.50.0/24".into()),
                port_spec: Some("22,80,443".into()),
                no_services: false,
                csv: Some(PathBuf::from("scan.csv")),
                json: true,
                help: false,
            }
        );
    }

    #[test]
    fn explicit_target_and_no_services_are_supported() {
        let args = parse(&["--target", "10.0.0.0/24", "--no-services"]);
        assert_eq!(args.target.as_deref(), Some("10.0.0.0/24"));
        assert!(args.no_services);
    }

    #[test]
    fn bad_flags_are_rejected() {
        assert!(parse_args(["--wat".to_string()]).is_err());
        assert!(parse_args(["--target".to_string()]).is_err());
    }

    #[test]
    fn table_clipping_stays_ascii_safe() {
        assert_eq!(clip("short", 10), "short");
        assert_eq!(clip("abcdefghijkl", 6), "abcde~");
    }

    #[test]
    fn csv_quotes_commas_and_quotes() {
        assert_eq!(csv_field("Dell, Inc."), "\"Dell, Inc.\"");
        assert_eq!(csv_field("a\"b"), "\"a\"\"b\"");
        assert_eq!(csv_field("plain"), "plain");
    }
}
