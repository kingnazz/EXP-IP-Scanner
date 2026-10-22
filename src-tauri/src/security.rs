//! Passive web-exposure assessment for discovered devices.
//!
//! This module deliberately does not send exploit payloads. It fingerprints
//! web services that the normal network scan already found, reads ordinary
//! response headers/body metadata, and turns that evidence into technician-
//! friendly findings. The goal is triage: identify systems that deserve an
//! immediate patch/version check without turning a LAN scanner into an exploit
//! framework.

use std::collections::{BTreeSet, HashSet};
use std::net::Ipv4Addr;

use chrono::Utc;
use serde::Serialize;
use tokio::process::Command;

const MAX_BODY_CHARS: usize = 64 * 1024;
const WEB_PORTS: [u16; 9] = [80, 443, 5000, 5001, 8000, 8008, 8080, 8443, 8888];
const PHP2SHELL_CVES: [&str; 2] = ["CVE-2026-109618", "CVE-2026-109619"];

#[derive(Debug, Clone, Serialize)]
pub struct WebServiceFingerprint {
    pub port: u16,
    pub scheme: String,
    pub status: Option<u16>,
    pub server: Option<String>,
    pub powered_by: Option<String>,
    pub php_version: Option<String>,
    pub product: Option<String>,
    pub title: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SecurityFinding {
    pub id: String,
    pub severity: String,
    pub title: String,
    pub summary: String,
    pub evidence: String,
    pub remediation: String,
    pub cves: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SecurityAssessment {
    pub target: String,
    pub checked_at: String,
    pub status: String,
    pub summary: String,
    pub web_services: Vec<WebServiceFingerprint>,
    pub findings: Vec<SecurityFinding>,
}

#[tauri::command]
pub async fn security_assessment(
    ip: String,
    open_ports: Vec<u16>,
) -> Result<SecurityAssessment, String> {
    let address: Ipv4Addr = ip
        .parse()
        .map_err(|_| "Security checks currently require a discovered IPv4 address.".to_string())?;

    // Only touch web ports already found open by the normal scan. This keeps
    // the security pass bounded and predictable, and avoids silently broadening
    // a consultant's requested scan scope.
    let open: BTreeSet<u16> = open_ports.into_iter().collect();
    let ports: Vec<u16> = WEB_PORTS
        .into_iter()
        .filter(|port| open.contains(port))
        .collect();

    if ports.is_empty() {
        return Ok(SecurityAssessment {
            target: address.to_string(),
            checked_at: Utc::now().to_rfc3339(),
            status: "clear".into(),
            summary: "No common HTTP/HTTPS management ports were found in this scan.".into(),
            web_services: Vec::new(),
            findings: Vec::new(),
        });
    }

    let mut services = Vec::new();
    for port in ports {
        services.push(fingerprint_service(address, port).await);
    }

    let findings = build_findings(&services);
    let (status, summary) = assessment_summary(&services, &findings);

    Ok(SecurityAssessment {
        target: address.to_string(),
        checked_at: Utc::now().to_rfc3339(),
        status,
        summary,
        web_services: services,
        findings,
    })
}

async fn fingerprint_service(ip: Ipv4Addr, port: u16) -> WebServiceFingerprint {
    let scheme = if is_tls_port(port) { "https" } else { "http" };
    let url = format!("{scheme}://{ip}:{port}/");

    let output = Command::new(curl_binary())
        .args([
            "--insecure",
            "--silent",
            "--show-error",
            "--location",
            "--max-time",
            "3",
            "--connect-timeout",
            "2",
            "--max-redirs",
            "2",
            "--range",
            "0-65535",
            "--max-filesize",
            "65536",
            "--include",
            "--user-agent",
            "EXP-IP-Scanner/1.3 passive-security-assessment",
            &url,
        ])
        .output()
        .await;

    let output = match output {
        Ok(output) => output,
        Err(_) => {
            return WebServiceFingerprint {
                port,
                scheme: scheme.into(),
                status: None,
                server: None,
                powered_by: None,
                php_version: None,
                product: synology_port_product(port),
                title: None,
                note: Some("The operating system curl client is unavailable, so HTTPS fingerprinting could not run.".into()),
            }
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let parsed = parse_http_output(&stdout);

    let Some((status, headers, body)) = parsed else {
        let note = if stderr.to_ascii_lowercase().contains("timed out") {
            "Web service did not answer the passive HTTP request before timeout."
        } else {
            "TCP port was discovered, but a normal HTTP/HTTPS response could not be fingerprinted."
        };
        return WebServiceFingerprint {
            port,
            scheme: scheme.into(),
            status: None,
            server: None,
            powered_by: None,
            php_version: None,
            product: synology_port_product(port),
            title: None,
            note: Some(note.into()),
        };
    };

    let server = header_value(&headers, "server");
    let powered_by = header_value(&headers, "x-powered-by");
    let body = truncate(&body, MAX_BODY_CHARS);

    let php_version = powered_by
        .as_deref()
        .and_then(extract_php_version)
        .or_else(|| server.as_deref().and_then(extract_php_version))
        .or_else(|| extract_php_version(&body));
    let product = detect_product(port, server.as_deref(), powered_by.as_deref(), &body);
    let title = extract_title(&body);

    WebServiceFingerprint {
        port,
        scheme: scheme.into(),
        status: Some(status),
        server,
        powered_by,
        php_version,
        product,
        title,
        note: if output.status.success() {
            None
        } else {
            Some("The service returned enough metadata to fingerprint, but curl stopped before receiving a complete body.".into())
        },
    }
}

fn curl_binary() -> &'static str {
    if cfg!(windows) { "curl.exe" } else { "curl" }
}

fn parse_http_output(raw: &str) -> Option<(u16, Vec<(String, String)>, String)> {
    let normalized = raw.replace("\r\n", "\n");
    let parts: Vec<&str> = normalized.split("\n\n").collect();
    let mut last_header_index = None;
    let mut status = None;
    let mut headers = Vec::new();

    for (index, block) in parts.iter().enumerate() {
        let mut lines = block.lines();
        let first = lines.next()?.trim();
        if !first.starts_with("HTTP/") {
            if last_header_index.is_some() {
                break;
            }
            continue;
        }
        status = first.split_whitespace().nth(1).and_then(|value| value.parse().ok());
        headers = lines
            .filter_map(|line| {
                let (name, value) = line.split_once(':')?;
                Some((name.trim().to_ascii_lowercase(), value.trim().to_string()))
            })
            .collect();
        last_header_index = Some(index);
    }

    let header_index = last_header_index?;
    let status = status?;
    let body = parts
        .iter()
        .skip(header_index + 1)
        .copied()
        .collect::<Vec<_>>()
        .join("\n\n");
    Some((status, headers, body))
}

fn header_value(headers: &[(String, String)], name: &str) -> Option<String> {
    headers
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.clone())
        .filter(|value| !value.is_empty())
}

fn is_tls_port(port: u16) -> bool {
    matches!(port, 443 | 5001 | 8443)
}

fn synology_port_product(port: u16) -> Option<String> {
    matches!(port, 5000 | 5001).then(|| "Possible Synology DSM".to_string())
}

fn detect_product(
    port: u16,
    server: Option<&str>,
    powered_by: Option<&str>,
    body: &str,
) -> Option<String> {
    let body_lower = body.to_ascii_lowercase();
    let server_lower = server.unwrap_or_default().to_ascii_lowercase();
    let powered_lower = powered_by.unwrap_or_default().to_ascii_lowercase();

    if body_lower.contains("synology")
        || body_lower.contains("diskstation")
        || server_lower.contains("synology")
        || (matches!(port, 5000 | 5001) && body_lower.contains("dsm"))
    {
        return Some("Synology DSM".into());
    }
    if body_lower.contains("wp-content/") || body_lower.contains("wordpress") {
        return Some("WordPress".into());
    }
    if body_lower.contains("phpmyadmin") {
        return Some("phpMyAdmin".into());
    }
    if powered_lower.contains("php") {
        return Some("PHP web application".into());
    }
    if server_lower.contains("apache") {
        return Some("Apache HTTP Server".into());
    }
    if server_lower.contains("nginx") {
        return Some("nginx".into());
    }
    synology_port_product(port)
}

fn extract_title(body: &str) -> Option<String> {
    let lower = body.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let after_open = lower[start..].find('>')? + start + 1;
    let end = lower[after_open..].find("</title>")? + after_open;
    let title = body[after_open..end]
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (!title.is_empty()).then(|| truncate(&title, 120))
}

fn extract_php_version(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    for marker in ["php/", "php version ", "php "] {
        let mut offset = 0usize;
        while let Some(relative) = lower[offset..].find(marker) {
            let start = offset + relative + marker.len();
            let candidate: String = text[start..]
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .take(16)
                .collect();
            if parse_version(&candidate).is_some() {
                return Some(candidate.trim_end_matches('.').to_string());
            }
            offset = start.min(lower.len());
            if offset >= lower.len() {
                break;
            }
        }
    }
    None
}

fn parse_version(version: &str) -> Option<(u16, u16, u16)> {
    let mut parts = version.trim().trim_end_matches('.').split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

fn build_findings(services: &[WebServiceFingerprint]) -> Vec<SecurityFinding> {
    let mut findings = Vec::new();
    let mut seen_versions = HashSet::new();
    let mut php_indicator_without_version = false;
    let mut synology_ports = Vec::new();

    for service in services {
        if service
            .product
            .as_deref()
            .is_some_and(|product| product.contains("Synology"))
        {
            synology_ports.push(service.port);
        }

        if let Some(version) = service.php_version.as_deref() {
            if seen_versions.insert(version.to_string()) {
                findings.push(php_version_finding(version, service));
            }
        } else if service
            .powered_by
            .as_deref()
            .is_some_and(|value| value.to_ascii_lowercase().contains("php"))
            || service
                .product
                .as_deref()
                .is_some_and(|product| matches!(product, "PHP web application" | "WordPress" | "phpMyAdmin"))
        {
            php_indicator_without_version = true;
        }
    }

    if php_indicator_without_version && seen_versions.is_empty() {
        findings.push(SecurityFinding {
            id: "php2shell-version-hidden".into(),
            severity: "high".into(),
            title: "PHP web runtime detected; patch level unknown".into(),
            summary: "This web service appears to use PHP, but it does not disclose a version. A passive scan cannot determine whether the PHP2Shell fixes are installed.".into(),
            evidence: "PHP application/runtime indicators were present in ordinary HTTP response metadata or content, but no reliable PHP version was exposed.".into(),
            remediation: "Verify the server or appliance runtime directly. For upstream PHP, use 8.2.35+, 8.3.36+, 8.4.27+, or 8.5.12+; for vendor appliances, install the vendor update that includes the PHP fixes.".into(),
            cves: cves(),
        });
    }

    if !synology_ports.is_empty() {
        synology_ports.sort_unstable();
        synology_ports.dedup();
        findings.push(SecurityFinding {
            id: "synology-dsm-web".into(),
            severity: "info".into(),
            title: "Synology DSM web management detected".into(),
            summary: "A Synology management surface appears to be present on this device.".into(),
            evidence: format!("Synology indicators were seen on web port(s): {}.", join_ports(&synology_ports)),
            remediation: "Keep DSM and installed packages current. If Web Station or a PHP package is installed, verify its PHP patch level separately; DSM being present does not by itself prove PHP2Shell exposure.".into(),
            cves: Vec::new(),
        });
    }

    findings
}

fn php_version_finding(version: &str, service: &WebServiceFingerprint) -> SecurityFinding {
    let parsed = parse_version(version);
    let evidence = format!(
        "{} service on port {} disclosed PHP {}{}.",
        service.scheme,
        service.port,
        version,
        service
            .powered_by
            .as_deref()
            .map(|value| format!(" via X-Powered-By: {value}"))
            .unwrap_or_default()
    );

    match parsed {
        Some((8, 2, patch)) if patch < 35 => vulnerable_php_finding(version, evidence),
        Some((8, 3, patch)) if patch < 36 => vulnerable_php_finding(version, evidence),
        Some((8, 4, patch)) if patch < 27 => vulnerable_php_finding(version, evidence),
        Some((8, 5, patch)) if patch < 12 => vulnerable_php_finding(version, evidence),
        Some((8, 2, _)) | Some((8, 3, _)) | Some((8, 4, _)) | Some((8, 5, _)) => SecurityFinding {
            id: format!("php2shell-patched-{version}"),
            severity: "info".into(),
            title: format!("PHP {version} includes the upstream PHP2Shell fixes"),
            summary: "The disclosed upstream PHP version is at or above the fixed release for its branch.".into(),
            evidence,
            remediation: "No PHP2Shell action is indicated by this disclosed version. Continue normal patching and verify vendor backports separately on appliances.".into(),
            cves: cves(),
        },
        Some((major, minor, _)) if major < 8 || (major == 8 && minor < 2) => SecurityFinding {
            id: format!("php2shell-legacy-{version}"),
            severity: "high".into(),
            title: format!("Legacy PHP {version} requires vendor verification"),
            summary: "This PHP branch is older than the currently supported upstream branches. Version comparison alone cannot tell whether a distribution/vendor backported the fixes.".into(),
            evidence,
            remediation: "Check the OS or appliance vendor advisory/package revision. Upgrade to a currently supported PHP branch where practical.".into(),
            cves: cves(),
        },
        _ => SecurityFinding {
            id: format!("php-version-{version}"),
            severity: "info".into(),
            title: format!("PHP {version} detected"),
            summary: "PHP was identified, but this version does not match a branch EXP IP Scanner can safely classify from the upstream fixed-version table.".into(),
            evidence,
            remediation: "Confirm the runtime against the PHP or vendor security advisory.".into(),
            cves: cves(),
        },
    }
}

fn vulnerable_php_finding(version: &str, evidence: String) -> SecurityFinding {
    SecurityFinding {
        id: format!("php2shell-likely-{version}"),
        severity: "critical".into(),
        title: format!("PHP {version} is below the PHP2Shell fixed release"),
        summary: "The disclosed upstream PHP version falls in an affected 8.2-8.5 range for the two critical PHP2Shell remote-code-execution vulnerabilities.".into(),
        evidence,
        remediation: "Patch immediately. Minimum upstream fixed releases are PHP 8.2.35, 8.3.36, 8.4.27, and 8.5.12. If this is an appliance, install the vendor update rather than replacing its embedded PHP manually.".into(),
        cves: cves(),
    }
}

fn assessment_summary(
    services: &[WebServiceFingerprint],
    findings: &[SecurityFinding],
) -> (String, String) {
    if findings.iter().any(|finding| finding.severity == "critical") {
        return (
            "critical".into(),
            "Critical PHP2Shell exposure indicator found. Review the disclosed PHP version and patch path immediately.".into(),
        );
    }
    if findings.iter().any(|finding| finding.severity == "high") {
        return (
            "attention".into(),
            "A PHP runtime may need patch verification. The passive check could not prove a safe patch level.".into(),
        );
    }
    if services.iter().all(|service| service.status.is_none()) {
        return (
            "unknown".into(),
            "Web ports were open, but the passive HTTP check could not read a response.".into(),
        );
    }
    if services.iter().any(|service| service.php_version.is_some()) {
        return (
            "clear".into(),
            "No vulnerable upstream PHP 8.2-8.5 version was disclosed by the checked web services.".into(),
        );
    }
    (
        "clear".into(),
        "No PHP runtime was identified in the passive web fingerprint. Hidden or embedded PHP can still require direct vendor/version verification.".into(),
    )
}

fn cves() -> Vec<String> {
    PHP2SHELL_CVES.iter().map(|value| (*value).to_string()).collect()
}

fn join_ports(ports: &[u16]) -> String {
    ports
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

fn truncate(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    value.chars().take(max.saturating_sub(1)).collect::<String>() + "…"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service(version: Option<&str>) -> WebServiceFingerprint {
        WebServiceFingerprint {
            port: 80,
            scheme: "http".into(),
            status: Some(200),
            server: Some("nginx".into()),
            powered_by: version.map(|value| format!("PHP/{value}")),
            php_version: version.map(ToOwned::to_owned),
            product: Some("PHP web application".into()),
            title: None,
            note: None,
        }
    }

    #[test]
    fn extracts_common_php_version_forms() {
        assert_eq!(extract_php_version("PHP/8.2.34"), Some("8.2.34".into()));
        assert_eq!(extract_php_version("PHP Version 8.4.27"), Some("8.4.27".into()));
        assert_eq!(extract_php_version("nginx"), None);
    }

    #[test]
    fn parses_curl_headers_and_body() {
        let raw = "HTTP/1.1 301 Moved\r\nLocation: /login\r\n\r\nHTTP/1.1 200 OK\r\nServer: nginx\r\nX-Powered-By: PHP/8.2.34\r\n\r\n<html><title>DSM</title></html>";
        let (status, headers, body) = parse_http_output(raw).unwrap();
        assert_eq!(status, 200);
        assert_eq!(header_value(&headers, "server").as_deref(), Some("nginx"));
        assert!(body.contains("DSM"));
    }

    #[test]
    fn classifies_fixed_and_unfixed_php_branches() {
        for (version, expected) in [
            ("8.2.34", "critical"),
            ("8.2.35", "info"),
            ("8.3.35", "critical"),
            ("8.3.36", "info"),
            ("8.4.26", "critical"),
            ("8.4.27", "info"),
            ("8.5.11", "critical"),
            ("8.5.12", "info"),
        ] {
            assert_eq!(php_version_finding(version, &service(Some(version))).severity, expected);
        }
    }

    #[test]
    fn legacy_php_is_not_called_vulnerable_without_vendor_context() {
        let finding = php_version_finding("7.4.33", &service(Some("7.4.33")));
        assert_eq!(finding.severity, "high");
        assert!(finding.title.contains("vendor verification"));
    }
}
