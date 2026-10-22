use exp_security::{
    fingerprint::detect,
    intelligence::{self, classify, version},
    models::*,
    transport::{self, WebProbe},
    DeepScanPolicy, LowImpactVerification,
};
use std::{
    collections::BTreeMap,
    net::{IpAddr, Ipv4Addr},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::watch,
};

fn headers(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}
fn php(v: Option<&str>) -> Technology {
    Technology {
        product: "PHP".into(),
        version: v.map(String::from),
        confidence: Confidence::High,
        evidence: vec!["Exposed HTTP header".into()],
    }
}
fn target(port: u16) -> DeviceTarget {
    DeviceTarget {
        ip: "127.0.0.1".into(),
        hostname: None,
        open_ports: vec![port],
    }
}
fn service() -> WebService {
    WebService {
        port: 443,
        protocol: "https".into(),
        endpoint: "https://127.0.0.1:443/".into(),
        status: Some(200),
        redirect_destination: None,
        title: None,
        server: None,
        technologies: vec![],
        admin_interfaces: vec![],
        tls: None,
        body_truncated: false,
        error: None,
    }
}

#[test]
fn synology_uses_independent_signals_and_does_not_infer_php_packages() {
    let result = detect(&BTreeMap::new(), include_str!("fixtures/dsm.html"));
    let dsm = result
        .technologies
        .iter()
        .find(|t| t.product == "Synology DSM")
        .unwrap();
    assert_eq!(dsm.confidence, Confidence::High);
    assert!(dsm.evidence.len() >= 2);
    assert_eq!(result.admin_interfaces, vec!["Synology DSM"]);
    assert!(!result.technologies.iter().any(|t| t.product == "PHP"));
    let weak = detect(&BTreeMap::new(), "<title>Synology</title>");
    assert_eq!(weak.technologies[0].confidence, Confidence::Low);
    assert!(weak.admin_interfaces.is_empty());
}
#[test]
fn wordpress_metadata_and_login_form_identify_admin_but_not_php_version() {
    let result = detect(&BTreeMap::new(), include_str!("fixtures/wordpress.html"));
    assert!(result.admin_interfaces.contains(&"WordPress".into()));
    assert!(result
        .technologies
        .iter()
        .any(|t| t.product == "WordPress" && t.version.as_deref() == Some("6.7.2")));
    assert!(result
        .technologies
        .iter()
        .any(|t| t.product == "PHP" && t.version.is_none()));
}
#[test]
fn article_content_and_incidental_titles_are_not_product_proof() {
    let result = detect(
        &BTreeMap::new(),
        include_str!("fixtures/false-positive.html"),
    );
    assert!(!result.technologies.iter().any(|t| matches!(
        t.product.as_str(),
        "PHP" | "WordPress" | "Apache" | "nginx" | "phpMyAdmin"
    )));
    assert!(result.admin_interfaces.is_empty());
}
#[test]
fn headers_expose_php_fpm_and_servers_without_conflating_platforms() {
    for (banner, name) in [
        ("Apache/2.4.62", "Apache"),
        ("nginx/1.26.2", "nginx"),
        ("Microsoft-IIS/10.0", "IIS"),
    ] {
        let result = detect(
            &headers(&[("server", banner), ("x-powered-by", "PHP-FPM/8.2.30")]),
            "",
        );
        assert!(result.technologies.iter().any(|t| t.product == name));
        assert!(result
            .technologies
            .iter()
            .any(|t| t.product == "PHP" && t.version.as_deref() == Some("8.2.30")));
        assert!(result.technologies.iter().any(|t| t.product == "PHP-FPM"));
    }
    let fake = detect(
        &headers(&[
            ("server", "notnginx/1.0"),
            ("x-powered-by", "NotPHP/8.2.30"),
        ]),
        "",
    );
    assert!(fake.technologies.is_empty());
}
#[test]
fn php2shell_required_version_cases_are_provisional_and_conservative() {
    let def = &intelligence::definitions()[0];
    for (v, expected) in [
        ("8.2.30", ExposureStatus::PossiblyVulnerable),
        ("8.2.35", ExposureStatus::Patched),
        ("8.3.30", ExposureStatus::PossiblyVulnerable),
        ("8.3.36", ExposureStatus::Patched),
        ("8.4.19", ExposureStatus::PossiblyVulnerable),
        ("8.4.27", ExposureStatus::Patched),
    ] {
        assert_eq!(classify(def, Some(&php(Some(v)))), expected, "{v}");
    }
    for v in [
        None,
        Some("8.2"),
        Some("8.2.30-ubuntu1"),
        Some("8.5.1"),
        Some("8.2.35RC1"),
    ] {
        assert_eq!(classify(def, Some(&php(v))), ExposureStatus::Unknown);
    }
    assert_eq!(classify(def, None), ExposureStatus::NotApplicable);
}
#[test]
fn versions_compare_numerically_and_reject_ambiguous_releases() {
    assert!(version("8.2.100") > version("8.2.35"));
    assert!(version("8.10.0") > version("8.9.9"));
    for v in [
        "8.2",
        "8.2.30.1",
        "8.2.-1",
        "8.2.30+vendor",
        "999999999999.0.1",
        "",
    ] {
        assert_eq!(version(v), None);
    }
}
#[test]
fn matching_findings_preserve_provenance_and_never_confirm_php2shell() {
    let mut s = service();
    s.technologies.push(php(Some("8.2.30")));
    let findings = intelligence::evaluate(&target(443), &s);
    let f = &findings[0];
    assert_eq!(f.status, FindingStatus::Possible);
    assert_eq!(f.severity, Severity::Critical);
    assert_eq!(f.confidence, Confidence::Low);
    assert_eq!(f.cve_ids.len(), 2);
    assert!(f.description.contains("user-supplied"));
    assert!(!f.remediation.is_empty());
    s.technologies[0].version = Some("8.2.35".into());
    assert_eq!(
        intelligence::evaluate(&target(443), &s)[0].status,
        FindingStatus::NotAffected
    );
}
#[test]
fn scoring_is_centralized_deduplicated_bounded_and_ignores_unaffected() {
    let mut f = intelligence::finding(&target(443), &service(), "a", "Test", Severity::Critical);
    f.status = FindingStatus::Possible;
    assert_eq!(intelligence::score(&[f.clone(), f.clone()]).value, 70);
    f.score_category = Some("admin_interface".into());
    assert_eq!(intelligence::score(&[f.clone()]).value, 95);
    f.score_category = Some("expired_tls".into());
    assert_eq!(intelligence::score(&[f.clone()]).value, 92);
    f.status = FindingStatus::NotAffected;
    assert_eq!(intelligence::score(&[f.clone()]).value, 100);
    let many: Vec<_> = (0..10)
        .map(|i| {
            let mut f = f.clone();
            f.finding_id = i.to_string();
            f.status = FindingStatus::Likely;
            f.score_category = None;
            f
        })
        .collect();
    assert_eq!(intelligence::score(&many).value, 0);
}
#[test]
fn tls_metadata_handles_dates_names_self_signed_and_malformed_der() {
    let ip = IpAddr::V4(Ipv4Addr::LOCALHOST);
    let valid = transport::certificate(include_bytes!("fixtures/valid.der"), ip, false);
    assert_eq!(valid.self_signed_indication, Some(true));
    assert_eq!(valid.hostname_mismatch, Some(false));
    assert_eq!(valid.expired, Some(false));
    assert!(!valid.trusted);
    let mismatch = transport::certificate(
        include_bytes!("fixtures/valid.der"),
        "192.0.2.1".parse().unwrap(),
        false,
    );
    assert_eq!(mismatch.hostname_mismatch, Some(true));
    assert_eq!(
        transport::certificate(include_bytes!("fixtures/expired.der"), ip, false).expired,
        Some(true)
    );
    assert_eq!(
        transport::certificate(include_bytes!("fixtures/future.der"), ip, false).not_yet_valid,
        Some(true)
    );
    assert!(transport::certificate(b"invalid", ip, true).error.is_some());
}
#[test]
fn endpoint_and_redirect_rules_support_ipv6_and_refuse_unsafe_schemes() {
    assert_eq!(
        transport::endpoint("::1".parse().unwrap(), 8080, "http"),
        "http://[::1]:8080/"
    );
    assert_eq!(
        transport::redirect(
            "http://192.0.2.1/",
            "https://user:secret@example.test/login?token=secret#secret"
        )
        .as_deref(),
        Some("https://example.test/login")
    );
    for url in [
        "javascript:alert(1)",
        "file:///etc/passwd",
        "data:text/html,test",
    ] {
        assert!(transport::redirect("http://192.0.2.1/", url).is_none());
    }
}
#[test]
fn malformed_html_and_headers_cannot_panic_or_leak_page_bodies_into_evidence() {
    let html = format!(
        "<title>{}</title><script><form action=bad.php\0{}",
        "x".repeat(500),
        "<".repeat(3000)
    );
    let result = detect(&headers(&[("server", "\u{202e}nginx\r\n")]), &html);
    assert!(result.title.unwrap().len() <= 160);
    assert!(!result
        .technologies
        .iter()
        .any(|t| t.evidence.iter().any(|e| e.contains("<script>"))));
}
#[test]
fn deep_scan_requires_explicit_authorization() {
    assert!(LowImpactVerification
        .authorize(false)
        .unwrap_err()
        .contains("authorized"));
    assert!(LowImpactVerification.authorize(true).is_ok());
}
async fn server(response: Vec<u8>, delay: Duration) -> (u16, tokio::task::JoinHandle<Vec<u8>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = vec![0; 2048];
        let n = socket.read(&mut request).await.unwrap_or(0);
        request.truncate(n);
        tokio::time::sleep(delay).await;
        let _ = socket.write_all(&response).await;
        request
    });
    (port, task)
}
#[tokio::test]
async fn request_is_identified_and_headers_fingerprint_without_following_redirects() {
    let (port,task)=server(b"HTTP/1.1 302 Found\r\nServer: nginx/1.26.2\r\nX-Powered-By: PHP/8.2.30\r\nLocation: https://unreachable.invalid/login?secret=123\r\nContent-Length: 0\r\n\r\n".to_vec(),Duration::ZERO).await;
    let r = WebProbe::new()
        .unwrap()
        .probe("127.0.0.1".parse().unwrap(), port, false)
        .await;
    assert_eq!(r.status, Some(302));
    assert_eq!(
        r.redirect_destination.as_deref(),
        Some("https://unreachable.invalid/login")
    );
    assert_eq!(r.technologies.len(), 2);
    let request = String::from_utf8(task.await.unwrap())
        .unwrap()
        .to_lowercase();
    assert!(request.starts_with("get / http/1.1"));
    assert!(request.contains("user-agent: exp-ip-scanner/safe-assessment"));
    assert!(!request.contains("authorization:"));
}
#[tokio::test]
async fn bodies_and_headers_are_bounded() {
    let body = "x".repeat(transport::MAX_BODY + 10000);
    let (port, task) = server(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        )
        .into_bytes(),
        Duration::ZERO,
    )
    .await;
    let r = WebProbe::new()
        .unwrap()
        .probe("127.0.0.1".parse().unwrap(), port, false)
        .await;
    assert!(r.body_truncated);
    task.await.unwrap();
    let (port, task) = server(
        format!(
            "HTTP/1.1 200 OK\r\nHuge: {}\r\nContent-Length: 0\r\n\r\n",
            "x".repeat(20000)
        )
        .into_bytes(),
        Duration::ZERO,
    )
    .await;
    let r = WebProbe::new()
        .unwrap()
        .probe("127.0.0.1".parse().unwrap(), port, false)
        .await;
    assert!(r.error.is_some());
    task.await.unwrap();
}
#[tokio::test]
async fn malformed_http_is_an_endpoint_error() {
    let (port, task) = server(b"NOT_HTTP\0\r\n".to_vec(), Duration::ZERO).await;
    let r = WebProbe::new()
        .unwrap()
        .probe("127.0.0.1".parse().unwrap(), port, false)
        .await;
    assert!(r.error.is_some());
    assert!(r.status.is_none());
    task.await.unwrap();
}
#[tokio::test]
async fn slow_response_times_out_without_waiting_indefinitely() {
    let (port, task) = server(vec![], Duration::from_secs(30)).await;
    let start = std::time::Instant::now();
    let r = WebProbe::new()
        .unwrap()
        .probe("127.0.0.1".parse().unwrap(), port, false)
        .await;
    assert!(r.error.unwrap().contains("timed out"));
    assert!(start.elapsed() < Duration::from_secs(5));
    task.abort();
}
#[tokio::test]
async fn malformed_targets_and_known_raw_print_ports_send_no_http() {
    let (_sender, cancel) = watch::channel(false);
    let mut bad = target(80);
    bad.ip = "http://example.test/".into();
    let run = exp_security::assess(vec![bad, target(9100)], 1, 2, false, cancel, |_| {})
        .await
        .unwrap();
    assert_eq!(run.devices.len(), 2);
    assert!(run.devices.iter().all(|d| d.services.is_empty()));
    assert!(run.devices.iter().any(|d| !d.complete));
}
#[tokio::test]
async fn cancellation_interrupts_inflight_work_and_drops_stale_results() {
    let (port, task) = server(vec![], Duration::from_secs(30)).await;
    let (sender, cancel) = watch::channel(false);
    let assessment = tokio::spawn(exp_security::assess(
        vec![target(port)],
        1,
        2,
        false,
        cancel,
        |_| {},
    ));
    tokio::time::sleep(Duration::from_millis(50)).await;
    sender.send(true).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(1), assessment)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result.cancelled);
    assert!(result.devices.is_empty());
    task.abort();
}
#[tokio::test]
async fn self_signed_https_still_yields_metadata_through_scoped_inspection() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let identity =
        native_tls::Identity::from_pkcs12(include_bytes!("fixtures/test-identity.p12"), "")
            .unwrap();
    let acceptor =
        tokio_native_tls::TlsAcceptor::from(native_tls::TlsAcceptor::new(identity).unwrap());
    let task = tokio::spawn(async move {
        for _ in 0..2 {
            let (socket, _) = listener.accept().await.unwrap();
            if let Ok(mut tls) = acceptor.accept(socket).await {
                let mut req = [0; 2048];
                let _ = tls.read(&mut req).await;
                let _ = tls
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                    .await;
            }
        }
    });
    let result = WebProbe::new()
        .unwrap()
        .probe("127.0.0.1".parse().unwrap(), port, true)
        .await;
    assert_eq!(result.status, Some(200));
    let tls = result.tls.unwrap();
    assert!(!tls.trusted);
    assert_eq!(tls.self_signed_indication, Some(true));
    assert_eq!(tls.hostname_mismatch, Some(false));
    task.await.unwrap();
}
#[tokio::test]
async fn service_findings_and_score_are_generated_end_to_end() {
    let body = include_str!("fixtures/dsm.html");
    let (port, task) = server(
        format!(
            "HTTP/1.1 200 OK\r\nX-Powered-By: PHP/8.2.30\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .into_bytes(),
        Duration::ZERO,
    )
    .await;
    let (_sender, cancel) = watch::channel(false);
    let mut events = 0;
    let result = exp_security::assess(vec![target(port)], 11, 22, false, cancel, |_| events += 1)
        .await
        .unwrap();
    assert_eq!(events, 1);
    assert_eq!(result.scan_id, 11);
    let d = &result.devices[0];
    assert!(d.findings.iter().any(|f| f.product == "Synology DSM"));
    assert!(d
        .findings
        .iter()
        .any(|f| f.status == FindingStatus::Possible));
    assert_eq!(d.score.value, 62);
    task.await.unwrap();
}

#[test]
fn product_names_in_asset_queries_do_not_establish_php_or_wordpress() {
    let r=detect(&BTreeMap::new(),"<title>WordPress tutorials</title><script src='https://cdn.example/test.js?search=/wp-content/'></script>");
    assert!(!r
        .technologies
        .iter()
        .any(|t| matches!(t.product.as_str(), "WordPress" | "PHP")));
}
#[tokio::test]
async fn duplicate_ports_are_cached_and_coverage_limits_are_explicit() {
    let (port, task) = server(
        b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".to_vec(),
        Duration::ZERO,
    )
    .await;
    let mut device = target(port);
    device.open_ports = vec![port, port];
    let (_sender, cancel) = watch::channel(false);
    let result = exp_security::assess(vec![device], 1, 2, false, cancel, |_| {})
        .await
        .unwrap();
    assert_eq!(result.devices[0].services.len(), 1);
    task.await.unwrap();
}
#[tokio::test]
async fn concurrent_assessments_share_the_global_request_ceiling() {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let in_flight = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let observed = peak.clone();
    let server = tokio::spawn(async move {
        let mut tasks = vec![];
        for _ in 0..24 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let active = in_flight.clone();
            let peak = observed.clone();
            tasks.push(tokio::spawn(async move {
                let mut buf = [0; 2048];
                let _ = socket.read(&mut buf).await;
                let n = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(n, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(40)).await;
                let _ = socket
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                    .await;
                active.fetch_sub(1, Ordering::SeqCst);
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }
    });
    let (_s1, c1) = watch::channel(false);
    let (_s2, c2) = watch::channel(false);
    let a = exp_security::assess(vec![target(port); 12], 1, 2, false, c1, |_| {});
    let b = exp_security::assess(vec![target(port); 12], 1, 3, false, c2, |_| {});
    let (a, b) = tokio::join!(a, b);
    assert_eq!(a.unwrap().devices.len(), 12);
    assert_eq!(b.unwrap().devices.len(), 12);
    server.await.unwrap();
    assert!((2..=8).contains(&peak.load(Ordering::SeqCst)));
}

#[test]
fn wordpress_login_and_webmin_need_structural_admin_evidence() {
    let wp=detect(&BTreeMap::new(),"<title>Log In - WordPress</title><link href='/wp-admin/css/login.min.css'><form action='/wp-login.php'></form>");
    assert!(wp.admin_interfaces.contains(&"WordPress".into()));
    let webmin = detect(
        &BTreeMap::new(),
        "<title>Login to Webmin</title><form action='/session_login.cgi'></form>",
    );
    assert!(webmin.admin_interfaces.contains(&"Webmin".into()));
    assert!(!webmin.technologies.iter().any(|t| t.product == "PHP"));
}
