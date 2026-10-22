//! Local security assessment service. No command execution or exploitation.
pub mod fingerprint;
pub mod intelligence;
pub mod models;
pub mod transport;

use futures::{stream, StreamExt};
use models::*;
use std::{
    collections::HashMap,
    net::IpAddr,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::sync::{watch, Semaphore};
use transport::WebProbe;

pub const WEB_PORTS: [u16; 8] = [80, 443, 8080, 8443, 8000, 8888, 5000, 5001];
pub const MAX_SERVICES: usize = 12;
const DEVICE_BUDGET: Duration = Duration::from_secs(12);
const RUN_BUDGET: Duration = Duration::from_secs(120);

/// A deliberately separate boundary for future opt-in active verification.
/// This implementation repeats Safe Scan only; no intrusive check exists.
pub trait DeepScanPolicy {
    fn authorize(&self, explicitly_confirmed: bool) -> Result<(), String>;
}
pub struct LowImpactVerification;
impl DeepScanPolicy for LowImpactVerification {
    fn authorize(&self, explicitly_confirmed: bool) -> Result<(), String> {
        if explicitly_confirmed {
            Ok(())
        } else {
            Err("Only scan systems you own or are authorized to test. Explicit confirmation is required.".into())
        }
    }
}
/// Extension point for opt-in verification checks. Phase 1 intentionally only
/// reruns the low-impact service; future active checks belong exclusively here.
pub struct DeepScanService;
impl DeepScanService {
    pub async fn verify<F>(
        targets: Vec<DeviceTarget>,
        scan_id: u64,
        assessment_id: u64,
        confirmed: bool,
        cancel: watch::Receiver<bool>,
        on_device: F,
    ) -> Result<AssessmentRun, String>
    where
        F: FnMut(&DeviceAssessment),
    {
        LowImpactVerification.authorize(confirmed)?;
        assess(targets, scan_id, assessment_id, true, cancel, on_device).await
    }
}
fn semaphore() -> Arc<Semaphore> {
    static SEM: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SEM.get_or_init(|| Arc::new(Semaphore::new(8))).clone()
}
fn service_findings(target: &DeviceTarget, service: &WebService) -> Vec<Finding> {
    let mut findings = vec![];
    if service.status.is_none() {
        return findings;
    }
    findings.extend(intelligence::evaluate(target, service));
    for name in &service.admin_interfaces {
        let mut f = intelligence::finding(
            target,
            service,
            &format!("admin-{}", name.replace(' ', "-")),
            "Exposed Administrative Interface",
            Severity::Medium,
        );
        f.status = FindingStatus::Confirmed;
        f.product = name.clone();
        f.confidence = Confidence::High;
        f.evidence = vec![format!(
            "Recognizable {name} interface reachable at {}",
            service.endpoint
        )];
        f.description="Management access is reachable from this scanner. Exposure is not necessarily a vulnerability; it increases attack surface. Internet reachability and network access policy were not tested.".into();
        f.remediation="Restrict management access to an administration VLAN or VPN, use HTTPS and MFA where supported, and review firewall rules.".into();
        f.score_category = Some("admin_interface".into());
        findings.push(f);
    }
    if service.protocol == "http"
        && service
            .redirect_destination
            .as_deref()
            .is_none_or(|url| !url.starts_with("https://"))
    {
        let mut f = intelligence::finding(
            target,
            service,
            "cleartext",
            "Unencrypted HTTP service",
            Severity::Low,
        );
        f.status = FindingStatus::Confirmed;
        f.evidence = vec!["HTTP response received without an HTTPS redirect".into()];
        f.description="This endpoint permits unencrypted HTTP. HTTPS may be available on another port; it is assessed separately when discovered.".into();
        f.remediation="Enable HTTPS and redirect HTTP to HTTPS. Avoid sending credentials over this endpoint.".into();
        findings.push(f);
    }
    if let Some(tls) = &service.tls {
        for (present,id,title,severity,remediation) in [
            (tls.expired==Some(true),"expired_tls","Expired TLS certificate",Severity::Medium,"Renew and install a valid certificate."),
            (tls.not_yet_valid==Some(true),"future_tls","TLS certificate is not yet valid",Severity::Medium,"Check device time and certificate validity dates."),
            (tls.hostname_mismatch==Some(true),"name_tls","TLS certificate does not match target IP",Severity::Low,"Use the certificate's intended DNS name, or issue a certificate with the appropriate subject alternative names."),
            (tls.self_signed_indication==Some(true),"self_tls","Self-signed certificate indication",Severity::Low,"Use a certificate issued by a CA trusted by your managed clients."),
            (!tls.trusted,"trust_tls","TLS identity could not be verified",Severity::Medium,"Review the certificate chain and distribute the appropriate trusted CA certificate."),
        ] {
            if !present {continue;}
            let mut f=intelligence::finding(target,service,id,title,severity);
            f.status=FindingStatus::Confirmed;f.evidence=vec![title.into()];f.description="TLS certificate observation for a connection to the discovered IP address. A DNS certificate may legitimately mismatch the IP; no reverse-DNS identity is assumed.".into();
            f.remediation=remediation.into(); if id=="expired_tls" {f.score_category=Some(id.into());}findings.push(f);
        }
    }
    findings
}
async fn assess_device(
    target: DeviceTarget,
    probe: WebProbe,
    mut cancel: watch::Receiver<bool>,
) -> DeviceAssessment {
    let mut services = vec![];
    let mut findings = vec![];
    let mut notes=vec!["Only discovered ports are assessed. No authentication, admin-path enumeration, exploit payloads or TLS protocol sweep. No PHP package inventory is inferred.".into()];
    let mut complete = true;
    if let Ok(ip) = target.ip.parse::<IpAddr>() {
        // Never send HTTP to known non-web protocols. In particular a raw
        // print socket can print an innocent GET. Unknown/custom ports remain
        // eligible, so web detection is not limited to a fixed port list.
        let mut ports:Vec<_>=target.open_ports.iter().copied().filter(|p| !matches!(p,
            20..=25|53|110|135|139|143|389|445|465|515|587|636|993|995|1433|1521|1723|1883|2049|3306|3389|5060|5061|5222|5432|5555|5900..=5905|6379|8883|9100|27017)).collect();
        if ports.len() != target.open_ports.len() {
            notes.push("Known non-web protocols (including raw printing) were excluded from HTTP requests.".into());
        }
        ports.sort_unstable();
        ports.dedup();
        ports.retain(|p| *p != 0);
        ports.sort_by_key(|p| (!WEB_PORTS.contains(p), *p));
        if ports.len() > MAX_SERVICES {
            complete = false;
            notes.push(format!(
                "Port budget: {} of {} discovered ports considered, common web ports first.",
                MAX_SERVICES,
                ports.len()
            ));
            ports.truncate(MAX_SERVICES);
        }
        let deadline = tokio::time::Instant::now() + DEVICE_BUDGET;
        // Scan-local endpoint cache; protocol fallback never repeats a successful request.
        let mut cache = HashMap::new();
        for port in ports {
            if *cancel.borrow() {
                complete = false;
                break;
            }
            let https = matches!(port, 443 | 8443 | 5001 | 5986 | 9443);
            let task = async {
                let _permit = semaphore().acquire_owned().await.ok()?;
                let first = probe.probe(ip, port, https).await;
                if first.status.is_some() {
                    return Some(first);
                }
                let second = probe.probe(ip, port, !https).await;
                Some(if second.status.is_some() {
                    second
                } else {
                    first
                })
            };
            let result = tokio::select! {
                _=cancel.changed()=>{complete=false;None},
                _=tokio::time::sleep_until(deadline)=>{complete=false;notes.push("Device request time budget reached.".into());None},
                result=task=>result,
            };
            let Some(service) = result else {
                break;
            };
            cache.entry(port).or_insert(service);
        }
        let mut entries: Vec<_> = cache.into_iter().collect();
        entries.sort_by_key(|(port, _)| *port);
        for (_, service) in entries {
            findings.extend(service_findings(&target, &service));
            services.push(service);
        }
        if services.iter().any(|s| s.error.is_some()) {
            complete = false;
            notes.push("Some services did not return complete HTTP responses; these are assessment gaps, not evidence of safety.".into());
        }
        if services.iter().all(|s| s.status.is_none()) {
            complete = false;
            notes.push("No web service was assessed. A score of 100 means no deductions from available observations, not a secure system.".into());
        }
    } else {
        complete = false;
        notes.push("Malformed target IP; no request sent.".into());
    }
    let score = intelligence::score(&findings);
    DeviceAssessment {
        device_ip: target.ip,
        hostname: target.hostname,
        services,
        findings,
        score,
        assessed_at: chrono::Utc::now().to_rfc3339(),
        complete,
        coverage_notes: notes,
    }
}
/// Streams bounded per-device assessments; cancellation drops in-flight requests.
/// The caller owns the generation and makes stale results ineligible for display.
pub async fn assess<F>(
    targets: Vec<DeviceTarget>,
    scan_id: u64,
    assessment_id: u64,
    deep: bool,
    cancel: watch::Receiver<bool>,
    mut on_device: F,
) -> Result<AssessmentRun, String>
where
    F: FnMut(&DeviceAssessment),
{
    let probe = WebProbe::new()?;
    let started_at = chrono::Utc::now().to_rfc3339();
    let mut devices = vec![];
    let mut receiver = cancel.clone();
    let mut work = stream::iter(
        targets
            .into_iter()
            .map(|target| assess_device(target, probe.clone(), cancel.clone())),
    )
    .buffer_unordered(4);
    let deadline = tokio::time::Instant::now() + RUN_BUDGET;
    let mut cancelled = *receiver.borrow();
    while !cancelled {
        tokio::select! {
            _=receiver.changed()=>{cancelled=true;},
            _=tokio::time::sleep_until(deadline)=>{cancelled=true;},
            next=work.next()=>match next {Some(device)=>{if *receiver.borrow() {cancelled=true;break;} on_device(&device);devices.push(device);},None=>break},
        }
    }
    Ok(AssessmentRun {
        assessment_id,
        scan_id,
        mode: if deep {
            "Deep Scan · low-impact verification only"
        } else {
            "Safe Scan"
        }
        .into(),
        started_at,
        completed_at: chrono::Utc::now().to_rfc3339(),
        cancelled,
        devices,
    })
}
