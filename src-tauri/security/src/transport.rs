use crate::{
    fingerprint::{clean, detect},
    models::*,
};
use reqwest::{Client, Url};
use std::{collections::BTreeMap, net::IpAddr, time::Duration};
use x509_parser::{extensions::GeneralName, prelude::*};

pub const MAX_BODY: usize = 64 * 1024;
pub const MAX_HEADER_VALUE: usize = 512;
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
#[derive(Clone)]
pub struct WebProbe {
    verified: Client,
    inspection: Client,
}
impl WebProbe {
    pub fn new() -> Result<Self, String> {
        // Match the installed updater's existing ring provider, preserving its
        // reqwest feature selection. Native TLS would change reqwest's default
        // backend for every consumer through Cargo feature unification.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let build = |inspection| {
            Client::builder()
                .tls_backend_rustls()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(1))
                .timeout(REQUEST_TIMEOUT)
                .user_agent("EXP-IP-Scanner/Safe-Assessment")
                .http1_only()
                .http1_max_headers(64)
                .pool_max_idle_per_host(0)
                .tls_info(true)
                .min_tls_version(reqwest::tls::Version::TLS_1_2)
                .tls_danger_accept_invalid_hostnames(inspection)
                .tls_danger_accept_invalid_certs(inspection)
                .build()
                .map_err(|_| String::from("Could not initialize local HTTP/TLS analysis"))
        };
        Ok(Self {
            verified: build(false)?,
            inspection: build(true)?,
        })
    }
    pub async fn probe(&self, ip: IpAddr, port: u16, https: bool) -> WebService {
        let protocol = if https { "https" } else { "http" };
        let endpoint = endpoint(ip, port, protocol);
        let mut service = WebService {
            port,
            protocol: protocol.into(),
            endpoint: endpoint.clone(),
            status: None,
            redirect_destination: None,
            title: None,
            server: None,
            technologies: vec![],
            admin_interfaces: vec![],
            tls: None,
            body_truncated: false,
            error: None,
        };
        let first = self.verified.get(&endpoint).send().await;
        let mut trusted = true;
        let response = match first {
            Ok(r) => Ok(r),
            // Certificate inspection is read-only and scoped to this client/IP.
            // No credentials, redirects, proxy, cookies or remote scripts.
            Err(e) if https && certificate_error(&e) => {
                trusted = false;
                self.inspection.get(&endpoint).send().await
            }
            Err(e) => Err(e),
        };
        let mut response = match response {
            Ok(r) => r,
            Err(e) => {
                service.error = Some(
                    if e.is_timeout() {
                        "Request timed out"
                    } else {
                        "HTTP/TLS handshake unavailable"
                    }
                    .into(),
                );
                if https {
                    service.tls = Some(TlsResult {
                        error: Some("TLS could not be assessed".into()),
                        ..Default::default()
                    });
                }
                return service;
            }
        };
        if response
            .headers()
            .iter()
            .map(|(k, v)| k.as_str().len() + v.as_bytes().len())
            .sum::<usize>()
            > 16 * 1024
        {
            service.error = Some("HTTP response headers exceeded 16 KiB acceptance limit".into());
            return service;
        }
        service.status = Some(response.status().as_u16());
        if https {
            service.tls = Some(
                response
                    .extensions()
                    .get::<reqwest::tls::TlsInfo>()
                    .and_then(|info| info.peer_certificate())
                    .map_or_else(
                        || TlsResult {
                            trusted,
                            error: Some("Peer certificate unavailable".into()),
                            ..Default::default()
                        },
                        |der| certificate(der, ip, trusted),
                    ),
            );
        }
        let headers: BTreeMap<String, String> = ["server", "x-powered-by", "x-synology"]
            .into_iter()
            .filter_map(|name| {
                response
                    .headers()
                    .get(name)
                    .and_then(|v| v.to_str().ok())
                    .map(|v| (name.into(), clean(v, MAX_HEADER_VALUE)))
            })
            .collect();
        service.server = headers.get("server").cloned();
        service.redirect_destination = response
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| redirect(&endpoint, v));
        let html = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_none_or(|v| {
                let media_type = v.split(';').next().unwrap_or("").trim();
                ["text/html", "application/xhtml+xml", "text/plain"]
                    .iter()
                    .any(|expected| media_type.eq_ignore_ascii_case(expected))
            });
        let mut body = Vec::new();
        if html {
            loop {
                match response.chunk().await {
                    Ok(Some(chunk)) => {
                        let remaining = MAX_BODY.saturating_sub(body.len());
                        body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
                        if body.len() >= MAX_BODY {
                            service.body_truncated = true;
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        service.error = Some(
                            if e.is_timeout() {
                                "Response body timed out"
                            } else {
                                "Incomplete or malformed HTTP body"
                            }
                            .into(),
                        );
                        break;
                    }
                }
            }
        }
        let result = detect(&headers, &String::from_utf8_lossy(&body));
        service.title = result.title;
        service.technologies = result.technologies;
        service.admin_interfaces = result.admin_interfaces;
        service
    }
}
fn certificate_error(error: &reqwest::Error) -> bool {
    let mut current: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(source) = current {
        if source.downcast_ref::<rustls::Error>().is_some_and(|e| {
            matches!(
                e,
                rustls::Error::InvalidCertificate(_) | rustls::Error::NoCertificatesPresented
            )
        }) {
            return true;
        }
        // io::Error::source can skip its immediate wrapped error. Hyper wraps
        // rustls errors in nested io::Errors, so inspect get_ref explicitly.
        current = match source
            .downcast_ref::<std::io::Error>()
            .and_then(|e| e.get_ref())
        {
            Some(inner) => Some(inner),
            None => source.source(),
        };
    }
    false
}
pub fn endpoint(ip: IpAddr, port: u16, scheme: &str) -> String {
    match ip {
        IpAddr::V4(_) => format!("{scheme}://{ip}:{port}/"),
        IpAddr::V6(_) => format!("{scheme}://[{ip}]:{port}/"),
    }
}
/// Only a redacted display destination. Redirects are never fetched.
pub fn redirect(base: &str, location: &str) -> Option<String> {
    if location.len() > 2048 {
        return None;
    }
    let mut url = Url::parse(base).ok()?.join(location).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    url.set_username("").ok()?;
    url.set_password(None).ok()?;
    url.set_query(None);
    url.set_fragment(None);
    Some(clean(url.as_str(), 512))
}
pub fn certificate(der: &[u8], ip: IpAddr, trusted: bool) -> TlsResult {
    let Ok((_, cert)) = parse_x509_certificate(der) else {
        return TlsResult {
            trusted: false,
            error: Some("Malformed peer certificate".into()),
            ..Default::default()
        };
    };
    let now = ASN1Time::now();
    let matches = cert.subject_alternative_name().ok().flatten().map(|san| {
        san.value.general_names.iter().any(|name| match name {
            GeneralName::IPAddress(bytes) => match ip {
                IpAddr::V4(v) => *bytes == v.octets(),
                IpAddr::V6(v) => *bytes == v.octets(),
            },
            _ => false,
        })
    });
    TlsResult {certificate_subject:Some(clean(&cert.subject().to_string(),256)),certificate_issuer:Some(clean(&cert.issuer().to_string(),256)),
        expires_at:cert.validity().not_after.to_rfc2822().ok(),expired:Some(cert.validity().not_after<now),not_yet_valid:Some(cert.validity().not_before>now),
        hostname_mismatch:Some(!matches.unwrap_or(false)),self_signed_indication:Some(cert.subject()==cert.issuer()),trusted,
        error:(!trusted).then(||"Certificate trust validation failed; inspected without sending credentials. Identity is not verified.".into()),obsolete_protocols_tested:false }
}
