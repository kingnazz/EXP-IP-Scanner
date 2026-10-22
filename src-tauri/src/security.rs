//! Tauri adapter around the independently testable security service.
//! Targets come only from the most recent discovery result, never remote URLs.
use exp_security::{
    models::{AssessmentRun, DeviceAssessment, DeviceTarget},
    DeepScanPolicy,
};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use tauri::{Emitter, Window};
use tokio::sync::watch;

static LAST_SCAN: Mutex<Option<crate::scanner::ScanResult>> = Mutex::new(None);
static ACTIVE: Mutex<Option<(u64, watch::Sender<bool>)>> = Mutex::new(None);
static LATEST_ASSESSMENT: AtomicU64 = AtomicU64::new(0);
static CANCELLED_THROUGH: AtomicU64 = AtomicU64::new(0);

pub fn reset() {
    let mut last = LAST_SCAN.lock().unwrap();
    if let Some((id, sender)) = ACTIVE.lock().unwrap().take() {
        CANCELLED_THROUGH.fetch_max(id, Ordering::SeqCst);
        let _ = sender.send(true);
    }
    *last = None;
}
pub fn remember(result: &crate::scanner::ScanResult) {
    *LAST_SCAN.lock().unwrap() = Some(result.clone());
}
#[derive(Clone, serde::Serialize)]
struct SecurityEvent {
    scan_id: u64,
    assessment_id: u64,
    devices: Vec<DeviceAssessment>,
}
#[tauri::command]
pub async fn assess_security(
    window: Window,
    scan_id: u64,
    assessment_id: u64,
    deep: bool,
    confirmed: bool,
) -> Result<AssessmentRun, String> {
    if deep {
        exp_security::LowImpactVerification.authorize(confirmed)?;
    }
    // No mutex guard may cross an await. Check and register against the same
    // discovery snapshot before any network work begins.
    let (targets, receiver) = {
        let last = LAST_SCAN.lock().unwrap();
        let result = last
            .as_ref()
            .filter(|r| r.scan_id == scan_id)
            .ok_or("Discovery result is no longer current. Run discovery first.")?;
        let mut active = ACTIVE.lock().unwrap();
        if assessment_id == 0
            || assessment_id <= LATEST_ASSESSMENT.load(Ordering::SeqCst)
            || assessment_id <= CANCELLED_THROUGH.load(Ordering::SeqCst)
        {
            return Err("Assessment was cancelled before it started.".into());
        }
        if let Some((_, sender)) = active.take() {
            let _ = sender.send(true);
        }
        LATEST_ASSESSMENT.store(assessment_id, Ordering::SeqCst);
        let (sender, receiver) = watch::channel(false);
        *active = Some((assessment_id, sender));
        (
            result
                .hosts
                .iter()
                .map(|h| DeviceTarget {
                    ip: h.ip.clone(),
                    hostname: h.hostname.clone(),
                    open_ports: h.open_ports.clone(),
                })
                .collect(),
            receiver,
        )
    };
    let mut pending = Vec::new();
    let mut last_emit = std::time::Instant::now();
    let emit = |device: &DeviceAssessment| {
        pending.push(device.clone());
        if pending.len() < 25 && last_emit.elapsed() < std::time::Duration::from_millis(100) {
            return;
        }
        last_emit = std::time::Instant::now();
        let _ = window.emit(
            "security:device",
            SecurityEvent {
                scan_id,
                assessment_id,
                devices: std::mem::take(&mut pending),
            },
        );
    };
    let result = if deep {
        exp_security::DeepScanService::verify(
            targets,
            scan_id,
            assessment_id,
            confirmed,
            receiver,
            emit,
        )
        .await
    } else {
        exp_security::assess(targets, scan_id, assessment_id, false, receiver, emit).await
    };
    if !pending.is_empty() {
        let _ = window.emit(
            "security:device",
            SecurityEvent {
                scan_id,
                assessment_id,
                devices: pending,
            },
        );
    }
    let mut active = ACTIVE.lock().unwrap();
    if active.as_ref().is_some_and(|(id, _)| *id == assessment_id) {
        *active = None;
    }
    result
}
#[tauri::command]
pub fn cancel_security(assessment_id: u64) {
    CANCELLED_THROUGH.fetch_max(assessment_id, Ordering::SeqCst);
    let mut active = ACTIVE.lock().unwrap();
    if active.as_ref().is_some_and(|(id, _)| *id == assessment_id) {
        if let Some((_, sender)) = active.take() {
            let _ = sender.send(true);
        }
    }
}
