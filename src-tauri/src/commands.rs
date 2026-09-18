//! The Tauri command surface exposed to the interface.
//!
//! Every command is a narrow, named capability. The webview is granted no
//! shell, filesystem or generic opener permission of its own (see
//! `capabilities/`), so anything it can reach the operating system through is
//! in this file or in [`crate::launch`], with its input validated in Rust.

use serde::Serialize;
use tauri::{Emitter, Window};

use crate::launch::{self, PingOutcome};
use crate::netinfo::{self, LocalNetwork};
use crate::ports;
use crate::runtime::{self, RuntimeInfo};
use crate::scanner::{self, ScanEvent, ScanOptions, ScanResult};

/// Where the project lives, for the links in the About panel. Fixed
/// destinations: the interface cannot pass a URL, so these surfaces cannot be
/// pointed anywhere else.
const SITE_URL: &str = "https://nazar-exp.github.io/EXP-IP-Scanner/";
const RELEASES_URL: &str = "https://github.com/nazar-exp/EXP-IP-Scanner/releases";
const PRIVACY_URL: &str = "https://nazar-exp.github.io/EXP-IP-Scanner/privacy.html";

/// Which edition this is, its version, and how it updates.
#[tauri::command]
pub fn runtime_info() -> RuntimeInfo {
    runtime::info()
}

/// The usable local networks, best default first, each with its gateway.
///
/// Called once at startup. This is what fills the network summary and the
/// target field before the technician touches anything. Async because the
/// gateway comes from the routing table, and reading it must not block the
/// window while it opens.
#[tauri::command]
pub async fn detect_networks() -> Vec<LocalNetwork> {
    netinfo::detect().await
}

/// One known TCP service.
#[derive(Debug, Clone, Serialize)]
pub struct ServiceInfo {
    pub port: u16,
    pub name: String,
}

/// The service-name table, fetched once at startup so the interface keeps no
/// second copy of it that can drift out of step with the scanner.
#[tauri::command]
pub fn service_catalog() -> Vec<ServiceInfo> {
    ports::catalog()
        .into_iter()
        .map(|(port, name)| ServiceInfo {
            port,
            name: name.to_string(),
        })
        .collect()
}

/// The default technician service set, so Settings can show and restore it
/// without hardcoding the list a second time.
#[tauri::command]
pub fn default_ports() -> Vec<u16> {
    ports::DEFAULT_PORTS.to_vec()
}

/// Parse a port specification using the backend's rules. The backend is the
/// authority on ports, so the interface asks instead of reimplementing them.
#[tauri::command]
pub fn parse_port_spec(spec: String) -> Result<Vec<u16>, String> {
    ports::parse_spec(&spec)
}

/// What a scan would do, so the empty state can say "254 addresses" and a large
/// scan can be flagged before the technician commits to it.
#[derive(Debug, Clone, Serialize)]
pub struct ScanPreview {
    pub total: usize,
    pub port_count: usize,
    pub workload: u64,
    pub warning: Option<String>,
}

/// Validate a scan request without running it, through the same code path the
/// scan itself uses, so the preview can never disagree with what happens next.
#[tauri::command]
pub fn preview_scan(opts: ScanOptions) -> Result<ScanPreview, String> {
    let plan = scanner::plan(&opts)?;
    Ok(ScanPreview {
        total: plan.hosts.len(),
        port_count: plan.ports.len(),
        workload: plan.workload,
        warning: plan.warning,
    })
}

#[derive(Serialize, Clone)]
struct HostEvent {
    scan_id: u64,
    host: Box<scanner::HostResult>,
    /// True only for the last update a device will receive in this scan. Absent
    /// from a discovery event, which is never final by definition.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    is_final: bool,
}

#[derive(Serialize, Clone)]
struct RemovedEvent {
    scan_id: u64,
    ip: String,
}

/// Run a scan, streaming structured events to the window as they happen so
/// devices appear in the table while the scan is still running.
///
/// Every event carries the scan id and the interface drops events whose id is
/// not the scan it is showing. That is what keeps a late event from a stopped
/// scan out of the next one's table.
#[tauri::command]
pub async fn scan_network(window: Window, opts: ScanOptions) -> Result<ScanResult, String> {
    let scan_id = scanner::next_scan_id();
    // Bounded: when the bridge cannot keep up the scanner waits for capacity,
    // dropping only advisory progress events, so event memory cannot grow
    // without limit during a wide scan.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<ScanEvent>(scanner::EVENT_CHANNEL_CAPACITY);
    let win = window.clone();
    let bridge = tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            let _ = match event {
                ScanEvent::Started(payload) => win.emit("scan:started", payload),
                ScanEvent::Progress(payload) => win.emit("scan:progress", payload),
                ScanEvent::HostDiscovered { scan_id, host } => win.emit(
                    "scan:host-discovered",
                    HostEvent {
                        scan_id,
                        host,
                        is_final: false,
                    },
                ),
                ScanEvent::HostUpdated {
                    scan_id,
                    host,
                    is_final,
                } => win.emit(
                    "scan:host-updated",
                    HostEvent {
                        scan_id,
                        host,
                        is_final,
                    },
                ),
                ScanEvent::HostRemoved { scan_id, ip } => {
                    win.emit("scan:host-removed", RemovedEvent { scan_id, ip })
                }
            };
        }
    });

    let result = scanner::run(opts, scan_id, Some(tx)).await;
    // Draining the bridge before returning guarantees the interface holds every
    // device event by the time the promise resolves, so the streamed table and
    // the returned result cannot disagree.
    let _ = bridge.await;
    result
}

/// Ask the running scan to stop. It ends early and still returns every device
/// found up to that point.
#[tauri::command]
pub fn cancel_scan() {
    scanner::request_cancel();
}

/// Extensions an export may use. Everything else is refused, so this command
/// cannot be used to drop an arbitrary file type even from a compromised
/// webview.
const EXPORT_EXTENSIONS: [&str; 1] = ["csv"];

/// Largest export accepted, as a plain sanity bound. A /16 of devices is far
/// below this; anything larger did not come from this application.
const MAX_EXPORT_BYTES: usize = 32 * 1024 * 1024;

fn validate_export_path(path: &str) -> Result<(), String> {
    let p = std::path::Path::new(path);
    if !p.is_absolute() {
        return Err("Exports can only be saved to a path chosen in the save dialog.".into());
    }
    let ok = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| EXPORT_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false);
    if !ok {
        return Err("Exports can only be saved as a .csv file.".into());
    }
    Ok(())
}

/// Write an already-formatted CSV, built in the interface, to the path the
/// technician chose in the native save dialog.
#[tauri::command]
pub fn save_text(path: String, contents: String) -> Result<(), String> {
    validate_export_path(&path)?;
    if contents.len() > MAX_EXPORT_BYTES {
        return Err("That export is unreasonably large and was not written.".into());
    }
    std::fs::write(&path, contents).map_err(|e| format!("Could not save {path}. {e}"))
}

// --- Technician actions ----------------------------------------------------

#[tauri::command]
pub fn open_web(app: tauri::AppHandle, ip: String, port: Option<u16>) -> Result<(), String> {
    launch::open_web(&app, &ip, port)
}

#[tauri::command]
pub fn open_smb(app: tauri::AppHandle, ip: String) -> Result<(), String> {
    launch::open_smb(&app, &ip)
}

#[tauri::command]
pub fn open_rdp(app: tauri::AppHandle, ip: String) -> Result<(), String> {
    launch::open_rdp(&app, &ip)
}

#[tauri::command]
pub fn open_ssh(app: tauri::AppHandle, ip: String) -> Result<(), String> {
    launch::open_ssh(&app, &ip)
}

#[tauri::command]
pub fn open_vnc(app: tauri::AppHandle, ip: String, port: Option<u16>) -> Result<(), String> {
    launch::open_vnc(&app, &ip, port)
}

#[tauri::command]
pub fn open_ping_console(ip: String) -> Result<(), String> {
    launch::open_ping_console(&ip)
}

#[tauri::command]
pub fn open_traceroute_console(ip: String) -> Result<(), String> {
    launch::open_traceroute_console(&ip)
}

#[tauri::command]
pub async fn ping_host(ip: String) -> Result<PingOutcome, String> {
    launch::ping_once(&ip, 1_500).await
}

// --- Fixed destinations ----------------------------------------------------

#[tauri::command]
pub fn open_site(app: tauri::AppHandle) -> Result<(), String> {
    open_fixed(&app, SITE_URL)
}

#[tauri::command]
pub fn open_releases(app: tauri::AppHandle) -> Result<(), String> {
    open_fixed(&app, RELEASES_URL)
}

#[tauri::command]
pub fn open_privacy(app: tauri::AppHandle) -> Result<(), String> {
    open_fixed(&app, PRIVACY_URL)
}

fn open_fixed(app: &tauri::AppHandle, url: &'static str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("Windows could not open {url}. {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_paths_are_restricted_to_csv_files_chosen_in_the_dialog() {
        let root = if cfg!(windows) {
            "C:\\exports\\"
        } else {
            "/exports/"
        };
        assert!(validate_export_path(&format!("{root}scan.csv")).is_ok());
        assert!(validate_export_path(&format!("{root}scan.CSV")).is_ok());

        // A relative path did not come from the save dialog.
        assert!(validate_export_path("scan.csv").is_err());
        // And nothing that is not a spreadsheet may be written.
        for bad in [
            "scan",
            "scan.exe",
            "scan.bat",
            "scan.ps1",
            ".bashrc",
            "scan.json",
        ] {
            assert!(
                validate_export_path(&format!("{root}{bad}")).is_err(),
                "accepted {bad}"
            );
        }
    }

    #[test]
    fn an_oversized_export_is_refused_rather_than_written() {
        let root = if cfg!(windows) {
            "C:\\exports\\"
        } else {
            "/exports/"
        };
        let huge = "x".repeat(MAX_EXPORT_BYTES + 1);
        let err = save_text(format!("{root}scan.csv"), huge).unwrap_err();
        assert!(err.contains("unreasonably large"), "{err}");
    }

    #[test]
    fn the_preview_agrees_with_what_a_scan_would_do() {
        let preview = preview_scan(ScanOptions::for_target("192.168.1.0/24")).unwrap();
        assert_eq!(preview.total, 254);
        assert_eq!(preview.port_count, ports::DEFAULT_PORTS.len());
        assert_eq!(preview.workload, 254 * ports::DEFAULT_PORTS.len() as u64);
        assert!(preview.warning.is_none());
    }

    #[test]
    fn the_preview_reports_a_bad_target_the_same_way_a_scan_would() {
        let err = preview_scan(ScanOptions::for_target("nonsense")).unwrap_err();
        assert!(err.contains("not a valid IPv4 address"), "{err}");
    }

    #[test]
    fn the_service_catalog_and_the_default_ports_line_up() {
        let catalog = service_catalog();
        assert!(!catalog.is_empty());
        for port in default_ports() {
            assert!(
                catalog.iter().any(|s| s.port == port),
                "default port {port} is missing from the catalog the interface reads"
            );
        }
    }

    #[test]
    fn port_specifications_are_parsed_by_the_backend() {
        assert_eq!(
            parse_port_spec("22, 80 443".into()).unwrap(),
            vec![22, 80, 443]
        );
        assert!(parse_port_spec("nope".into()).is_err());
        // Empty means the defaults, which is what the Settings field promises.
        assert_eq!(
            parse_port_spec("".into()).unwrap(),
            ports::DEFAULT_PORTS.to_vec()
        );
    }
}
