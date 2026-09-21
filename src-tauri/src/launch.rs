//! Consultant actions: the commands that take a consultant from a row in the
//! table to the device itself.
//!
//! This is the module that decides what a right-click can do, so it is also the
//! module where argument injection would matter. Every entry point takes an
//! address as a string from the webview and refuses anything that is not a
//! bare, well-formed IPv4 address before it reaches a launcher. A port, where
//! one is accepted, is a `u16` and is range-checked. Nothing here builds a
//! command from free text.
//!
//! Adapted from ArcScan's `commands` module, which had already worked out the
//! per-platform launch details -- `mstsc /v:`, `explorer \\host`, an SSH
//! session that deliberately keeps its console window -- and the validation
//! boundary that makes them safe to expose.

use std::net::Ipv4Addr;
use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

#[cfg(windows)]
use crate::scanner::quiet_command;

/// Reject anything that is not a bare, well-formed IPv4 address before it is
/// handed to a launcher.
///
/// Deliberately strict: no hostname, no CIDR, no port suffix, no scheme, no
/// whitespace beyond surrounding trim. Every action in this module is reachable
/// from the webview, and the webview is the least trusted thing in the process.
pub fn validated_ipv4(ip: &str) -> Result<Ipv4Addr, String> {
    let ip = ip.trim();
    ip.parse::<Ipv4Addr>()
        .map_err(|_| format!("`{ip}` is not a valid IPv4 address."))
}

/// Build the URL the web action opens: a validated address plus an optional
/// port, so nothing from the webview can smuggle in a different host or scheme.
pub fn web_url(ip: Ipv4Addr, port: Option<u16>) -> String {
    let scheme = match port {
        Some(443) | Some(8443) | Some(4443) | Some(5986) => "https",
        _ => "http",
    };
    match port {
        Some(p) if p != 80 && p != 443 => format!("{scheme}://{ip}:{p}"),
        _ => format!("{scheme}://{ip}"),
    }
}

fn open_external(app: &AppHandle, url: &str) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("Windows could not open {url}. {e}"))
}

/// Open the device's web interface in the default browser.
pub fn open_web(app: &AppHandle, ip: &str, port: Option<u16>) -> Result<(), String> {
    let ip = validated_ipv4(ip)?;
    open_external(app, &web_url(ip, port))
}

/// Open the device's Windows file shares.
pub fn open_smb(app: &AppHandle, ip: &str) -> Result<(), String> {
    let ip = validated_ipv4(ip)?;
    #[cfg(windows)]
    {
        let _ = app;
        // File Explorer is the native handler for a UNC path. Not launched
        // through `quiet_command`: Explorer is a window the consultant wants.
        std::process::Command::new("explorer.exe")
            .arg(format!("\\\\{ip}"))
            .spawn()
            .map_err(|e| format!("Windows could not open \\\\{ip}. {e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        open_external(app, &format!("smb://{ip}"))
    }
}

/// Open a Remote Desktop session.
pub fn open_rdp(app: &AppHandle, ip: &str) -> Result<(), String> {
    let ip = validated_ipv4(ip)?;
    #[cfg(windows)]
    {
        let _ = app;
        // mstsc draws its own window; only the launching shell is suppressed.
        quiet_command("mstsc")
            .arg(format!("/v:{ip}"))
            .spawn()
            .map_err(|e| format!("Windows could not start Remote Desktop for {ip}. {e}"))?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        std::process::Command::new("open")
            .arg(format!("rdp://full%20address=s:{ip}"))
            .spawn()
            .map_err(|e| {
                format!("No Remote Desktop client answered for {ip}. Install Windows App. {e}")
            })?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = app;
        for (client, args) in [
            ("xfreerdp", vec![format!("/v:{ip}")]),
            ("remmina", vec!["-c".to_string(), format!("rdp://{ip}")]),
        ] {
            if std::process::Command::new(client)
                .args(&args)
                .spawn()
                .is_ok()
            {
                return Ok(());
            }
        }
        Err(format!(
            "No Remote Desktop client is installed to connect to {ip}."
        ))
    }
}

/// Open an interactive SSH session.
///
/// The one action that deliberately keeps its console window: an SSH session is
/// something the consultant types into, so suppressing the window would launch
/// a process nobody can use.
pub fn open_ssh(app: &AppHandle, ip: &str) -> Result<(), String> {
    let ip = validated_ipv4(ip)?;
    #[cfg(windows)]
    {
        let _ = app;
        std::process::Command::new("cmd")
            .args(["/c", "start", "ssh", &ip.to_string()])
            .spawn()
            .map_err(|e| format!("Windows could not start SSH for {ip}. {e}"))?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        // `ip` is a validated bare IPv4 -- digits and dots only -- so
        // interpolating it into the script cannot introduce another command.
        let script =
            format!("tell application \"Terminal\"\nactivate\ndo script \"ssh {ip}\"\nend tell");
        std::process::Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|e| format!("Could not start SSH for {ip}. {e}"))?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = app;
        for term in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
            if std::process::Command::new(term)
                .args(["-e", "ssh", &ip.to_string()])
                .spawn()
                .is_ok()
            {
                return Ok(());
            }
        }
        Err("No terminal is installed to open an SSH session in.".into())
    }
}

/// Open a VNC session.
///
/// Best effort by design. Windows has no built-in VNC client, so a locally
/// registered `vnc://` handler -- RealVNC, TightVNC, UltraVNC all register one
/// -- is asked to take it, and the failure message says plainly what is
/// missing rather than silently doing nothing.
pub fn open_vnc(app: &AppHandle, ip: &str, port: Option<u16>) -> Result<(), String> {
    let ip = validated_ipv4(ip)?;
    let url = match port {
        Some(p) if p != 5900 => format!("vnc://{ip}:{p}"),
        _ => format!("vnc://{ip}"),
    };
    app.opener().open_url(&url, None::<&str>).map_err(|e| {
        format!("No VNC client is registered to open {url}. Install a VNC viewer. {e}")
    })
}

/// Open a console window running a continuous ping.
///
/// The console is the point: a consultant watching a device reboot wants the
/// replies scrolling in front of them, and wants to stop it with Ctrl+C.
pub fn open_ping_console(ip: &str) -> Result<(), String> {
    let ip = validated_ipv4(ip)?;
    #[cfg(windows)]
    {
        // `start` gives it its own window; `cmd /k` keeps that window open
        // after Ctrl+C so the output can still be read and copied.
        std::process::Command::new("cmd")
            .args(["/c", "start", "cmd", "/k", "ping", "-t", &ip.to_string()])
            .spawn()
            .map_err(|e| format!("Windows could not open a command prompt for {ip}. {e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        open_in_terminal(&["ping", &ip.to_string()])
    }
}

/// Open a console window running a traceroute.
pub fn open_traceroute_console(ip: &str) -> Result<(), String> {
    let ip = validated_ipv4(ip)?;
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "cmd", "/k", "tracert", &ip.to_string()])
            .spawn()
            .map_err(|e| format!("Windows could not open a command prompt for {ip}. {e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        open_in_terminal(&["traceroute", &ip.to_string()])
    }
}

#[cfg(not(windows))]
fn open_in_terminal(argv: &[&str]) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "tell application \"Terminal\"\nactivate\ndo script \"{}\"\nend tell",
            argv.join(" ")
        );
        std::process::Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|e| format!("Could not open a terminal. {e}"))?;
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        for term in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
            let mut cmd = std::process::Command::new(term);
            cmd.arg("-e");
            cmd.args(argv);
            if cmd.spawn().is_ok() {
                return Ok(());
            }
        }
        Err("No terminal is installed to run that in.".into())
    }
}

/// What an in-app ping found.
///
/// Shown in the details panel rather than a console, so a consultant can check
/// one device without leaving the results table.
#[derive(Debug, Clone, Serialize)]
pub struct PingOutcome {
    pub ip: String,
    pub replied: bool,
    pub rtt_ms: Option<f64>,
    pub ttl: Option<u8>,
    /// One line, already phrased for display.
    pub summary: String,
}

/// Run a short four-ping health check and summarise packet loss and timing.
///
/// Four probes match the familiar Windows ping default and avoid treating one
/// lucky reply as the whole story. The separate command-prompt action remains
/// continuous for consultants watching a device reboot.
const QUICK_PING_COUNT: usize = 4;

pub async fn ping_quick(ip: &str, timeout_ms: u64) -> Result<PingOutcome, String> {
    let ip = validated_ipv4(ip)?;
    let ms = timeout_ms.clamp(100, 10_000);
    let mut replies = Vec::with_capacity(QUICK_PING_COUNT);
    let mut ttl = None;

    for attempt in 0..QUICK_PING_COUNT {
        if let Some((rtt_ms, reply_ttl)) =
            crate::scanner::ping_for_action(ip, Duration::from_millis(ms)).await
        {
            replies.push(rtt_ms);
            if ttl.is_none() {
                ttl = reply_ttl;
            }
        }

        if attempt + 1 < QUICK_PING_COUNT {
            tokio::time::sleep(Duration::from_millis(125)).await;
        }
    }

    Ok(summarize_ping(ip, ms, &replies, ttl))
}

fn summarize_ping(ip: Ipv4Addr, timeout_ms: u64, replies: &[f64], ttl: Option<u8>) -> PingOutcome {
    let received = replies.len();
    if received == 0 {
        return PingOutcome {
            ip: ip.to_string(),
            replied: false,
            rtt_ms: None,
            ttl: None,
            summary: format!(
                "{QUICK_PING_COUNT} sent · 0 received · 100% loss · No replies from {ip} within {timeout_ms} ms each. The device may be off or block ping."
            ),
        };
    }

    let min_ms = replies.iter().copied().fold(f64::INFINITY, f64::min);
    let max_ms = replies.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let avg_ms = replies.iter().sum::<f64>() / received as f64;
    let loss_percent = ((QUICK_PING_COUNT - received) * 100) / QUICK_PING_COUNT;
    let ttl_text = ttl.map_or_else(String::new, |value| format!(" · TTL {value}"));

    PingOutcome {
        ip: ip.to_string(),
        replied: true,
        rtt_ms: Some(avg_ms),
        ttl,
        summary: format!(
            "{QUICK_PING_COUNT} sent · {received} received · {loss_percent}% loss · min {min_ms:.2} ms · avg {avg_ms:.2} ms · max {max_ms:.2} ms{ttl_text}"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_everything_that_is_not_a_bare_ipv4() {
        // Anything that could smuggle an argument, a host or a scheme into a
        // launcher has to be refused before it reaches one.
        for bad in [
            "",
            "   ",
            "example.com",
            "10.0.0.1; rm -rf /",
            "10.0.0.1 --flag",
            "10.0.0.1/24",
            "10.0.0.1:8080",
            "::1",
            "fe80::1",
            "10.0.0",
            "10.0.0.256",
            "http://10.0.0.1",
            "10.0.0.1\nevil",
            "$(reboot)",
            "10.0.0.1&calc",
            "\"10.0.0.1\"",
            "10.0.0.1\\..\\..\\windows",
            "-10.0.0.1",
            "10.0.0.1 10.0.0.2",
        ] {
            assert!(validated_ipv4(bad).is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    fn accepts_ordinary_addresses_with_surrounding_whitespace() {
        assert_eq!(
            validated_ipv4(" 192.168.1.20 ").unwrap(),
            "192.168.1.20".parse::<Ipv4Addr>().unwrap()
        );
    }

    #[test]
    fn web_urls_carry_nothing_but_the_validated_address_and_port() {
        let ip: Ipv4Addr = "10.0.0.9".parse().unwrap();
        assert_eq!(web_url(ip, None), "http://10.0.0.9");
        assert_eq!(web_url(ip, Some(80)), "http://10.0.0.9");
        assert_eq!(web_url(ip, Some(443)), "https://10.0.0.9");
        assert_eq!(web_url(ip, Some(8443)), "https://10.0.0.9:8443");
        assert_eq!(web_url(ip, Some(8080)), "http://10.0.0.9:8080");
        assert_eq!(web_url(ip, Some(5986)), "https://10.0.0.9:5986");
        assert_eq!(web_url(ip, Some(9100)), "http://10.0.0.9:9100");
    }

    #[test]
    fn a_ping_against_an_invalid_address_fails_before_spawning_anything() {
        let outcome = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(ping_quick("not-an-ip", 500));
        assert!(outcome.is_err());
    }

    #[test]
    fn four_ping_summary_reports_loss_and_timing() {
        let ip: Ipv4Addr = "192.0.2.10".parse().unwrap();
        let outcome = summarize_ping(ip, 1_500, &[0.8, 1.0, 1.2], Some(64));
        assert!(outcome.replied);
        assert_eq!(
            outcome.summary,
            "4 sent · 3 received · 25% loss · min 0.80 ms · avg 1.00 ms · max 1.20 ms · TTL 64"
        );
    }

    #[test]
    fn a_ping_reports_a_readable_summary_either_way() {
        // 203.0.113.0/24 is reserved for documentation and must not answer, so
        // this exercises the no-reply wording without depending on a network.
        let outcome = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(ping_quick("203.0.113.7", 300))
            .unwrap();
        assert_eq!(outcome.ip, "203.0.113.7");
        assert!(!outcome.summary.is_empty());
        if outcome.replied {
            assert!(outcome.rtt_ms.is_some());
            assert!(outcome.summary.contains("received"));
        } else {
            assert!(outcome.summary.contains("No replies"));
            assert!(outcome.summary.contains("203.0.113.7"));
        }
    }
}
