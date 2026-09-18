//! The network scanner: liveness detection, service probing, MAC/vendor and
//! hostname resolution.
//!
//! Everything here is read-only discovery. There is no exploit, brute-force,
//! credential or evasion logic in this module and none belongs in it: the
//! product is a discovery and administration utility for networks the
//! technician is authorised to inspect.
//!
//! # What was reused from ArcScan, and why
//!
//! The probe strategy and the concurrency model are ArcScan's, adopted
//! deliberately rather than re-derived. They encode findings that are expensive
//! to rediscover:
//!
//! * ICMP goes through the OS `ping` binary instead of a raw socket, so
//!   scanning needs no administrator rights.
//! * A refused TCP connection (RST) proves a host is alive just as well as an
//!   open port does.
//! * The ARP cache is read *after* probing, because every probe forces the OS
//!   to ARP-resolve its target. On the local segment a resolved MAC is proof of
//!   life even for a device that drops every ICMP and TCP probe -- printers,
//!   phones, cameras, firewalled workstations. This is how a LAN scanner finds
//!   the devices Angry IP Scanner misses.
//! * A second ARP pass re-primes the addresses that did not resolve, which is
//!   what makes results *stable*: without it a slow or lossy device appears in
//!   one scan and vanishes from the next.
//! * Proxy-ARP has to be defended against, or a router that answers ARP for
//!   its whole subnet makes every address look occupied.
//!
//! # Concurrency model
//!
//! Three independent ceilings, because they exhaust three different resources:
//!
//! * **Host concurrency** -- how many addresses are worked on at once.
//! * **Global TCP concurrency** -- how many connection attempts exist across
//!   the *entire* scan. This is the limit that protects file descriptors and
//!   the customer's network gear, which drops ARP replies (making real hosts
//!   disappear) when hit with too much simultaneous fan-out.
//! * **Ping process concurrency** -- how many `ping` child processes run at
//!   once. Processes cost far more than sockets, so this is the tightest limit.
//!
//! Bounding host concurrency alone is not enough: one host fanning out to every
//! selected port at once means 64 hosts times 31 ports of simultaneous
//! connects, and a wider port list makes it far worse.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::mpsc::Sender;
use tokio::sync::{Notify, Semaphore};
use tokio::time::timeout;

use crate::ipparse;
use crate::netinfo;
use crate::oui;
use crate::ports;

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

/// The scan currently running, and the scan a stop was requested for.
///
/// Keying cancellation to a scan id means a Stop that lands just after a scan
/// finished cannot cancel the *next* one. Only one scan runs at a time -- the
/// button reads Stop while one is active -- so two counters are enough.
static ACTIVE_SCAN: AtomicU64 = AtomicU64::new(0);
static CANCEL_SCAN: AtomicU64 = AtomicU64::new(0);
static NEXT_SCAN_ID: AtomicU64 = AtomicU64::new(1);

/// Allocate the id that tags every event of one scan, so the interface can
/// discard events belonging to a scan it is no longer showing.
pub fn next_scan_id() -> u64 {
    NEXT_SCAN_ID.fetch_add(1, Ordering::Relaxed)
}

/// Wakes every cancellation-aware wait the moment a stop is requested, so Stop
/// interrupts the settle delays instead of waiting them out.
fn cancel_notify() -> &'static Notify {
    static NOTIFY: OnceLock<Notify> = OnceLock::new();
    NOTIFY.get_or_init(Notify::new)
}

/// Ask the running scan to stop as soon as it can.
///
/// It finishes early and still returns every device found so far, with whatever
/// MAC, vendor and hostname had already resolved. Stopping a scan is not the
/// same as throwing its results away.
pub fn request_cancel() {
    CANCEL_SCAN.store(ACTIVE_SCAN.load(Ordering::Relaxed), Ordering::Relaxed);
    cancel_notify().notify_waiters();
}

fn cancelled(scan_id: u64) -> bool {
    scan_id != 0 && CANCEL_SCAN.load(Ordering::Relaxed) == scan_id
}

/// Sleep that ends early when this scan is cancelled. Returns true if the scan
/// is cancelled, whether that happened before, during or right after the wait.
/// It waits on a notification rather than polling, so Stop lands immediately.
async fn cancellable_sleep(scan_id: u64, dur: Duration) -> bool {
    if cancelled(scan_id) {
        return true;
    }
    let sleep = tokio::time::sleep(dur);
    tokio::pin!(sleep);
    loop {
        // Register interest in the notification before re-checking the flag, so
        // a stop arriving between the check and the wait cannot be missed.
        let notified = cancel_notify().notified();
        tokio::pin!(notified);
        if cancelled(scan_id) {
            return true;
        }
        tokio::select! {
            _ = &mut sleep => return cancelled(scan_id),
            _ = &mut notified => {
                if cancelled(scan_id) {
                    return true;
                }
            }
        }
    }
}

/// Resolves once this scan is cancelled. Keeps a blocked event send from
/// pinning a cancelled scan forever.
async fn cancel_requested(scan_id: u64) {
    loop {
        let notified = cancel_notify().notified();
        tokio::pin!(notified);
        if cancelled(scan_id) {
            return;
        }
        notified.await;
    }
}

/// The phase boundaries at which a scan re-evaluates cancellation.
///
/// Tests register a hook on these to trigger a stop at an exact, deterministic
/// point, instead of racing a timer against real network waits. That is the
/// only reason this exists; in a release build `checkpoint` compiles away.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Checkpoint {
    BeforeProbing,
    AfterProbing,
    BeforeArpSettle,
    BeforeConfirm,
    BeforeFinalise,
}

#[cfg(test)]
#[allow(clippy::type_complexity)]
static CHECKPOINT_HOOK: std::sync::Mutex<Option<Box<dyn Fn(Checkpoint) + Send>>> =
    std::sync::Mutex::new(None);

fn checkpoint(cp: Checkpoint) {
    let _ = cp;
    #[cfg(test)]
    {
        if let Some(hook) = CHECKPOINT_HOOK.lock().unwrap().as_ref() {
            hook(cp);
        }
    }
}

// ---------------------------------------------------------------------------
// Limits and options
// ---------------------------------------------------------------------------

/// How many simultaneous operations of each kind a scan may run.
///
/// The defaults are deliberately conservative. Consumer and small-business
/// routers rate-limit and drop ARP replies when hit with too much simultaneous
/// fan-out, which makes real devices vanish from the results; a gentler sweep
/// finds more of them in one pass. Fast and wrong is not fast.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScanLimits {
    /// Addresses worked on at once.
    pub host_concurrency: usize,
    /// TCP connection attempts in flight across the whole scan.
    pub tcp_concurrency: usize,
    /// `ping` child processes running at once.
    pub ping_concurrency: usize,
}

impl Default for ScanLimits {
    fn default() -> Self {
        Self {
            host_concurrency: 64,
            tcp_concurrency: 256,
            ping_concurrency: 32,
        }
    }
}

impl ScanLimits {
    /// Clamp operator-supplied limits into ranges the app can sustain.
    fn clamped(self) -> Self {
        Self {
            host_concurrency: self.host_concurrency.clamp(1, 512),
            tcp_concurrency: self.tcp_concurrency.clamp(8, 1_024),
            ping_concurrency: self.ping_concurrency.clamp(1, 128),
        }
    }

    /// How many ports one host may probe simultaneously.
    ///
    /// The global semaphore is what actually bounds sockets; this only keeps the
    /// number of *pending futures* proportional to the work available, so a
    /// single-host 1,000-port scan is not throttled to a trickle while a /22
    /// sweep does not queue tens of thousands of futures.
    fn per_host_fanout(&self, host_count: usize) -> usize {
        let busy_hosts = host_count.min(self.host_concurrency).max(1);
        (self.tcp_concurrency / busy_hosts).clamp(4, 128)
    }
}

/// Ports probed when service detection is switched off.
///
/// Turning service detection off must not turn the scanner into a ping sweep:
/// plenty of Windows servers, printers and appliances drop ICMP but answer on
/// one of these, and a technician who cannot see them has been failed by a
/// setting. So a handful of near-universal ports are still probed for liveness
/// and for ARP priming, and whichever of them are open are reported honestly.
pub const LIVENESS_PORTS: [u16; 5] = [22, 80, 443, 445, 3389];

/// Probe budget for one scan: addresses times ports.
///
/// Rejecting by total workload rather than by address count alone is what stops
/// the combination that actually hurts. A /16 with the default service set is a
/// long but legitimate sweep; a /16 with a thousand ports is 65 million
/// connection attempts and is always a mistake.
pub const MAX_WORKLOAD: u64 = 3_000_000;

/// Workload above which the scan still runs but the interface says it will take
/// a while.
pub const WARN_WORKLOAD: u64 = 250_000;

/// Options for one scan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanOptions {
    pub target: String,
    /// Empty means the default technician service set.
    #[serde(default)]
    pub ports: Vec<u16>,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
    #[serde(default = "default_host_concurrency")]
    pub concurrency: usize,
    #[serde(default)]
    pub tcp_concurrency: Option<usize>,
    #[serde(default)]
    pub ping_concurrency: Option<usize>,
    /// Reverse-DNS lookups. On by default; a hostname is often the only thing
    /// that identifies a device.
    #[serde(default = "default_true")]
    pub resolve_hostnames: bool,
    /// Probe the selected service ports. Off falls back to [`LIVENESS_PORTS`].
    #[serde(default = "default_true")]
    pub scan_services: bool,
}

fn default_timeout() -> u64 {
    900
}

fn default_host_concurrency() -> usize {
    ScanLimits::default().host_concurrency
}

fn default_true() -> bool {
    true
}

impl ScanOptions {
    /// A scan of `target` with every default.
    ///
    /// A test helper: real requests arrive fully populated from the interface,
    /// which always sends the technician's current settings.
    #[cfg(test)]
    pub fn for_target(target: impl Into<String>) -> Self {
        let d = ScanLimits::default();
        ScanOptions {
            target: target.into(),
            ports: Vec::new(),
            timeout_ms: default_timeout(),
            concurrency: d.host_concurrency,
            tcp_concurrency: None,
            ping_concurrency: None,
            resolve_hostnames: true,
            scan_services: true,
        }
    }

    fn limits(&self) -> ScanLimits {
        let d = ScanLimits::default();
        ScanLimits {
            host_concurrency: self.concurrency,
            tcp_concurrency: self.tcp_concurrency.unwrap_or(d.tcp_concurrency),
            ping_concurrency: self.ping_concurrency.unwrap_or(d.ping_concurrency),
        }
        .clamped()
    }
}

// ---------------------------------------------------------------------------
// Results and events
// ---------------------------------------------------------------------------

/// One device as observed by one scan.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HostResult {
    pub ip: String,
    pub hostname: Option<String>,
    pub mac: Option<String>,
    pub vendor: Option<String>,
    pub open_ports: Vec<u16>,
    /// ICMP round-trip time as `ping` itself reported it, in milliseconds.
    pub icmp_ms: Option<f64>,
    /// Fastest TCP connection establishment across the probed ports.
    pub tcp_ms: Option<f64>,
    /// Fastest response of any kind, which is what the Latency column shows.
    pub latency_ms: Option<f64>,
    /// TTL from the ICMP echo reply, when a ping succeeded.
    pub ttl: Option<u8>,
    /// A coarse guess from the TTL, and labelled as a guess wherever it is
    /// shown. It is a hint about what kind of thing answered, not a claim.
    pub os_hint: Option<String>,
    /// True when the device is this machine.
    pub is_self: bool,
    pub seen_at: String,
}

impl HostResult {
    fn new(ip: Ipv4Addr, probe: &Probe, is_self: bool, seen_at: &str) -> Self {
        let latency_ms = match (probe.icmp_ms, probe.tcp_ms) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        HostResult {
            ip: ip.to_string(),
            hostname: None,
            mac: None,
            vendor: None,
            open_ports: probe.open_ports.clone(),
            icmp_ms: probe.icmp_ms,
            tcp_ms: probe.tcp_ms,
            latency_ms,
            ttl: probe.ttl,
            os_hint: probe.ttl.and_then(os_hint_from_ttl),
            is_self,
            seen_at: seen_at.to_string(),
        }
    }
}

/// The stage a scan is in. Drives the phase word in the progress strip.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScanPhase {
    /// Sweeping addresses with ICMP and TCP probes.
    Probing,
    /// Re-triggering ARP for local addresses that did not answer.
    Confirming,
    /// Reading the ARP cache and finishing names and manufacturers.
    Resolving,
    Done,
    Cancelled,
}

/// Progress streamed to the interface while a scan runs.
#[derive(Debug, Clone, Serialize)]
pub struct ScanProgress {
    pub scan_id: u64,
    pub done: usize,
    pub total: usize,
    /// Devices confirmed so far.
    pub found: usize,
    pub phase: ScanPhase,
    pub elapsed_ms: u64,
}

/// Emitted once at the start so the interface can size its progress display and
/// show any workload advisory.
#[derive(Debug, Clone, Serialize)]
pub struct ScanStarted {
    pub scan_id: u64,
    pub target: String,
    pub total: usize,
    pub port_count: usize,
    /// Non-blocking advisory, e.g. a large but legal workload.
    pub warning: Option<String>,
}

/// Result of a completed or cancelled scan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub scan_id: u64,
    pub target: String,
    pub duration_ms: u64,
    /// Addresses the target covers.
    pub scanned: usize,
    /// Addresses actually probed. Lower than `scanned` for a cancelled scan.
    pub probed: usize,
    pub hosts: Vec<HostResult>,
    /// True when the technician stopped the scan before it finished.
    pub cancelled: bool,
    /// The port set the scan actually probed, so an export says what it covered.
    pub ports: Vec<u16>,
}

/// How many events the scanner-to-interface channel buffers before applying
/// backpressure. Large enough to absorb a burst of discoveries, small enough
/// that a stalled consumer bounds memory instead of growing a queue forever.
pub const EVENT_CHANNEL_CAPACITY: usize = 512;

/// Everything the scanner streams to the command layer while running.
#[derive(Debug, Clone, Serialize)]
pub enum ScanEvent {
    Started(ScanStarted),
    Progress(ScanProgress),
    /// A device was found. Fields other than the address may still be empty.
    HostDiscovered {
        scan_id: u64,
        host: Box<HostResult>,
    },
    /// A device already reported gained a hostname, MAC or manufacturer.
    ///
    /// The interface merges these field by field, so an earlier fact is never
    /// lost to a later event that does not carry it. `is_final` marks the last
    /// update a device will get, which is what lets the table tell "not
    /// resolved yet" apart from "there is nothing to resolve": a reverse-DNS
    /// hit that lands mid-scan must not make a MAC that has not been read yet
    /// appear to be absent.
    HostUpdated {
        scan_id: u64,
        host: Box<HostResult>,
        is_final: bool,
    },
    /// An address reported during probing turned out not to be a device (see
    /// the proxy-ARP rule in [`run`]). Sent so the live table ends up identical
    /// to the finished result.
    HostRemoved {
        scan_id: u64,
        ip: String,
    },
}

/// The scanner's side of the bounded event channel.
///
/// Events fall into two classes, and the distinction is ArcScan's. *Critical*
/// events (started, discovered, removed, the final per-host update, the final
/// phase) must arrive or the streamed table would disagree with the finished
/// result, so the sink waits for capacity -- that wait is the backpressure that
/// bounds memory. *Advisory* events (intermediate progress) are dropped when
/// the channel is full, because a newer progress event supersedes a lost one.
///
/// Two situations must never wedge a scan: the receiver disappearing, which
/// makes sends fail immediately and is ignored, and a receiver that stops
/// consuming after a stop was requested, which is handled by abandoning the
/// send once cancellation is requested. The returned `ScanResult` is always the
/// source of truth.
#[derive(Clone)]
struct EventSink {
    tx: Option<Sender<ScanEvent>>,
    scan_id: u64,
}

impl EventSink {
    async fn critical(&self, event: ScanEvent) {
        let Some(tx) = &self.tx else { return };
        match tx.try_send(event) {
            Ok(()) | Err(TrySendError::Closed(_)) => {}
            Err(TrySendError::Full(event)) => {
                tokio::select! {
                    result = tx.send(event) => { let _ = result; }
                    _ = cancel_requested(self.scan_id) => {}
                }
            }
        }
    }

    fn advisory(&self, event: ScanEvent) {
        if let Some(tx) = &self.tx {
            let _ = tx.try_send(event);
        }
    }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/// The reverse-DNS lookups a running scan has started.
///
/// Named because the shape is otherwise four generics deep, and because the
/// handles are what the probe loop and [`collect_hostnames`] pass between them.
type DnsTasks = Arc<std::sync::Mutex<Vec<tokio::task::JoinHandle<Option<(Ipv4Addr, String)>>>>>;

/// A validated scan, ready to run. Produced by [`plan`] so the command layer
/// can reject bad input and report the workload before any probe is sent.
#[derive(Debug, Clone)]
pub struct ScanPlan {
    pub hosts: Vec<Ipv4Addr>,
    pub ports: Vec<u16>,
    pub limits: ScanLimits,
    pub timeout: Duration,
    pub workload: u64,
    pub warning: Option<String>,
}

/// Validate a scan request. Every limit that matters is enforced here, in Rust,
/// so the backend never relies on the interface having checked the same things.
pub fn plan(opts: &ScanOptions) -> Result<ScanPlan, String> {
    let hosts = ipparse::parse_target(&opts.target)?;
    let ports = if opts.scan_services {
        ports::sanitize(&opts.ports)?
    } else {
        LIVENESS_PORTS.to_vec()
    };
    let limits = opts.limits();
    let timeout_ms = opts.timeout_ms.clamp(50, 10_000);

    let workload = hosts.len() as u64 * ports.len() as u64;
    if workload > MAX_WORKLOAD {
        return Err(format!(
            "That scan would make {} connection attempts ({} addresses x {} ports), past the {} \
             attempt limit. Scan a smaller range or use fewer ports.",
            thousands(workload),
            thousands(hosts.len() as u64),
            ports.len(),
            thousands(MAX_WORKLOAD),
        ));
    }
    let warning = (workload > WARN_WORKLOAD).then(|| {
        format!(
            "Large scan: {} connection attempts across {} addresses. This will take a while and \
             puts sustained load on the network.",
            thousands(workload),
            thousands(hosts.len() as u64),
        )
    });

    Ok(ScanPlan {
        hosts,
        ports,
        limits,
        timeout: Duration::from_millis(timeout_ms),
        workload,
        warning,
    })
}

/// Group digits so a large number stays readable in a message.
fn thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/// Run a full scan, streaming events as devices are discovered and enriched.
///
/// `scan_id` tags every event and scopes cancellation. Cancellation is
/// re-evaluated before every phase, during every wait, and once more
/// immediately before the result is built, so the returned `cancelled` flag is
/// the scan's true final state rather than a value captured after probing.
pub async fn run(
    opts: ScanOptions,
    scan_id: u64,
    events: Option<Sender<ScanEvent>>,
) -> Result<ScanResult, String> {
    let ScanPlan {
        hosts,
        ports,
        limits,
        timeout: per_probe,
        warning,
        ..
    } = plan(&opts)?;

    // Take ownership of the cancellation slot for this scan, clearing any stale
    // request left by a previous one.
    ACTIVE_SCAN.store(scan_id, Ordering::Relaxed);
    CANCEL_SCAN.store(0, Ordering::Relaxed);

    let started = Instant::now();
    let scanned = hosts.len();
    let sink = EventSink {
        tx: events,
        scan_id,
    };

    sink.critical(ScanEvent::Started(ScanStarted {
        scan_id,
        target: opts.target.clone(),
        total: scanned,
        port_count: ports.len(),
        warning,
    }))
    .await;
    checkpoint(Checkpoint::BeforeProbing);

    // Our own segments, up front: they decide whether ARP is authoritative for
    // this target and therefore whether the re-prime pass is worth running.
    let locals = netinfo::detect();
    let own_ips: HashSet<Ipv4Addr> = locals.iter().filter_map(|n| n.ip.parse().ok()).collect();
    let local_ranges: Vec<(u32, u32)> = locals
        .iter()
        .filter_map(|n| {
            let ip: Ipv4Addr = n.ip.parse().ok()?;
            let mask = if n.prefix == 0 {
                0
            } else {
                u32::MAX << (32 - u32::from(n.prefix))
            };
            Some((u32::from(ip) & mask, mask))
        })
        .collect();
    let overlaps_local_subnet = hosts.iter().any(|ip| ip_in_ranges(*ip, &local_ranges));

    let tcp_sem = Arc::new(Semaphore::new(limits.tcp_concurrency));
    let ping_sem = Arc::new(Semaphore::new(limits.ping_concurrency));
    // Reverse DNS runs alongside probing rather than after it, so a name lands
    // in the table while the sweep is still going. It gets its own ceiling: a
    // resolver that is slow or absent must not consume the budget the probes
    // need.
    let dns_sem = Arc::new(Semaphore::new(limits.tcp_concurrency.min(64)));
    let ports = Arc::new(ports);
    let fanout = limits.per_host_fanout(scanned);

    let counters = Arc::new(Counters::default());
    let dns_tasks: DnsTasks = Arc::new(std::sync::Mutex::new(Vec::new()));
    let probe_started = Instant::now();

    let mut probe_results: Vec<(Ipv4Addr, Probe)> = stream::iter(hosts)
        .map(|ip| {
            let ports = Arc::clone(&ports);
            let tcp_sem = Arc::clone(&tcp_sem);
            let ping_sem = Arc::clone(&ping_sem);
            let dns_sem = Arc::clone(&dns_sem);
            let counters = Arc::clone(&counters);
            let dns_tasks = Arc::clone(&dns_tasks);
            let sink = sink.clone();
            let is_self = own_ips.contains(&ip);
            let resolve_hostnames = opts.resolve_hostnames;
            async move {
                // Once cancelled, drain the remaining addresses without probing
                // so the stream finishes immediately instead of running to the
                // end of the range. This is what makes Stop feel instant on a
                // wide sweep.
                let probe = if cancelled(scan_id) {
                    Probe::dead()
                } else {
                    let probe = probe_host(
                        ip,
                        &ports,
                        per_probe,
                        fanout,
                        Arc::clone(&tcp_sem),
                        Arc::clone(&ping_sem),
                    )
                    .await;
                    counters.probed.fetch_add(1, Ordering::Relaxed);
                    if probe.up {
                        counters.found.fetch_add(1, Ordering::Relaxed);
                        let now = chrono::Local::now().to_rfc3339();
                        let host = HostResult::new(ip, &probe, is_self, &now);
                        sink.critical(ScanEvent::HostDiscovered {
                            scan_id,
                            host: Box::new(host.clone()),
                        })
                        .await;

                        if resolve_hostnames {
                            let sink = sink.clone();
                            let handle = tokio::spawn(async move {
                                if cancelled(scan_id) {
                                    return None;
                                }
                                let _permit = dns_sem.acquire().await.ok()?;
                                if cancelled(scan_id) {
                                    return None;
                                }
                                let name = resolve_hostname(ip).await?;
                                // Stream the name straight away rather than
                                // holding it until the scan ends.
                                let mut named = host;
                                named.hostname = Some(name.clone());
                                sink.critical(ScanEvent::HostUpdated {
                                    scan_id,
                                    host: Box::new(named),
                                    is_final: false,
                                })
                                .await;
                                Some((ip, name))
                            });
                            if let Ok(mut tasks) = dns_tasks.lock() {
                                tasks.push(handle);
                            }
                        }
                    }
                    probe
                };
                let done = counters.done.fetch_add(1, Ordering::Relaxed) + 1;
                if counters.should_report(done, scanned) {
                    sink.advisory(ScanEvent::Progress(ScanProgress {
                        scan_id,
                        done,
                        total: scanned,
                        found: counters.found.load(Ordering::Relaxed),
                        phase: ScanPhase::Probing,
                        elapsed_ms: probe_started.elapsed().as_millis() as u64,
                    }));
                }
                (ip, probe)
            }
        })
        .buffer_unordered(limits.host_concurrency)
        .collect()
        .await;

    checkpoint(Checkpoint::AfterProbing);
    let probed = counters.probed.load(Ordering::Relaxed);
    let progress_at = |phase: ScanPhase| ScanProgress {
        scan_id,
        done: counters.done.load(Ordering::Relaxed),
        total: scanned,
        found: counters.found.load(Ordering::Relaxed),
        phase,
        elapsed_ms: started.elapsed().as_millis() as u64,
    };

    sink.advisory(ScanEvent::Progress(progress_at(ScanPhase::Resolving)));
    checkpoint(Checkpoint::BeforeArpSettle);

    // Two things that both need to happen next, and no reason to do them in
    // series: let late ARP replies from slow devices settle before reading the
    // cache, and collect the reverse-DNS lookups still in flight. The settle
    // ends the moment Stop is pressed.
    let (mut hostnames, mut arp) =
        futures::join!(collect_hostnames(Arc::clone(&dns_tasks)), async {
            cancellable_sleep(scan_id, Duration::from_millis(700)).await;
            read_arp_cache().await
        });

    // Is ARP authoritative for *this* target? Either the range overlaps one of
    // our own subnets, or one of the addresses we actually scanned resolved to
    // a real, non-proxy MAC.
    //
    // Unrelated ARP entries are not evidence: every machine has a gateway
    // entry, so treating a non-empty cache as proof of locality would apply
    // local-segment rules to a routed target and run a pointless re-prime pass.
    let arp_authoritative = overlaps_local_subnet || {
        let freq = proxy_frequencies(&arp, probe_results.iter().map(|(ip, _)| *ip));
        let threshold = proxy_threshold(scanned);
        probe_results
            .iter()
            .any(|(ip, _)| is_real_mac(&arp, &freq, threshold, ip))
    };

    // The second pass, and the reason results are stable rather than flickering
    // between scans. A device that answered a beat slowly, or dropped our first
    // packet (routine on Wi-Fi), has no ARP entry at the instant the cache is
    // read, so it shows up in one scan and disappears from the next. Re-trigger
    // ARP for every local address that still lacks an entry, let it settle,
    // then read and merge again.
    //
    // Routed targets never get here: they have no ARP entries to repair, so the
    // pass would be pure wasted traffic. A cancelled scan skips it entirely --
    // confirmation is expensive follow-up work, not preservation of what was
    // already found.
    checkpoint(Checkpoint::BeforeConfirm);
    if arp_authoritative && !cancelled(scan_id) {
        let needs_prime: Vec<Ipv4Addr> = probe_results
            .iter()
            .map(|(ip, _)| *ip)
            .filter(|ip| !own_ips.contains(ip) && !arp.contains_key(ip))
            .collect();
        if !needs_prime.is_empty() {
            sink.advisory(ScanEvent::Progress(progress_at(ScanPhase::Confirming)));
            stream::iter(needs_prime)
                .map(|ip| {
                    let ports = Arc::clone(&ports);
                    let tcp_sem = Arc::clone(&tcp_sem);
                    let ping_sem = Arc::clone(&ping_sem);
                    async move {
                        if !cancelled(scan_id) {
                            arp_prime(ip, &ports, per_probe, tcp_sem, ping_sem).await;
                        }
                    }
                })
                .buffer_unordered(limits.host_concurrency)
                .collect::<Vec<()>>()
                .await;
            cancellable_sleep(scan_id, Duration::from_millis(600)).await;
            // Union the two reads (latest wins), so an entry that resolved in
            // either pass is kept even if the other read missed it.
            arp.extend(read_arp_cache().await);
            sink.advisory(ScanEvent::Progress(progress_at(ScanPhase::Resolving)));
        }
    }

    // Guard against proxy-ARP. Some routers and access points -- and any
    // client-isolated Wi-Fi network -- answer ARP for *every* address in the
    // subnet with their own MAC, which would make the entire scanned range look
    // occupied. A MAC covering a large share of the range is such a responder,
    // not a device.
    let mac_freq = proxy_frequencies(&arp, probe_results.iter().map(|(ip, _)| *ip));
    let threshold = proxy_threshold(scanned);
    let has_real_mac = |ip: &Ipv4Addr| is_real_mac(&arp, &mac_freq, threshold, ip);

    let mut removed: Vec<String> = Vec::new();
    probe_results.retain(|(ip, p)| {
        let keep = should_keep_probe(
            ip,
            p,
            &own_ips,
            arp_authoritative,
            &arp,
            &mac_freq,
            threshold,
        );
        // A device already streamed as discovered that does not survive has to
        // be withdrawn, or the live table would disagree with the result.
        if !keep && p.up {
            removed.push(ip.to_string());
        }
        keep
    });
    for ip in removed {
        hostnames.remove(&ip.parse::<Ipv4Addr>().expect("formatted from an Ipv4Addr"));
        sink.critical(ScanEvent::HostRemoved { scan_id, ip }).await;
    }

    probe_results.sort_by_key(|(ip, _)| u32::from(*ip));

    // Final enrichment works entirely from data already in memory, so it runs
    // even for a cancelled scan: partial results keep every MAC, manufacturer
    // and hostname that had already resolved.
    checkpoint(Checkpoint::BeforeFinalise);
    let now = chrono::Local::now().to_rfc3339();
    let mut hosts_out: Vec<HostResult> = Vec::with_capacity(probe_results.len());
    for (ip, probe) in probe_results {
        let mut host = HostResult::new(ip, &probe, own_ips.contains(&ip), &now);
        // Never label a device with a proxy MAC: it belongs to the router, not
        // to the device, and would send a technician to the wrong place.
        host.mac = arp.get(&ip).filter(|_| has_real_mac(&ip)).cloned();
        host.vendor = host.mac.as_deref().and_then(oui::lookup);
        host.hostname = hostnames.get(&ip).cloned();
        sink.critical(ScanEvent::HostUpdated {
            scan_id,
            host: Box::new(host.clone()),
            is_final: true,
        })
        .await;
        hosts_out.push(host);
    }

    // The final cancellation state is decided here, at the very end, so a Stop
    // pressed during any later phase is honoured rather than a stale value
    // captured after probing.
    let was_cancelled = cancelled(scan_id);
    sink.critical(ScanEvent::Progress(progress_at(if was_cancelled {
        ScanPhase::Cancelled
    } else {
        ScanPhase::Done
    })))
    .await;

    ACTIVE_SCAN.store(0, Ordering::Relaxed);

    Ok(ScanResult {
        scan_id,
        target: opts.target,
        duration_ms: started.elapsed().as_millis() as u64,
        scanned,
        probed,
        hosts: hosts_out,
        cancelled: was_cancelled,
        ports: ports.as_ref().clone(),
    })
}

/// Await the reverse-DNS lookups started during probing.
///
/// Each task already streamed its own update, so this only gathers the names
/// for the finished result. A task that panicked or was cancelled contributes
/// nothing rather than failing the scan: a missing hostname is a blank cell,
/// not an error worth showing a technician.
async fn collect_hostnames(tasks: DnsTasks) -> HashMap<Ipv4Addr, String> {
    let handles: Vec<_> = match tasks.lock() {
        Ok(mut guard) => std::mem::take(&mut *guard),
        Err(_) => Vec::new(),
    };
    let mut out = HashMap::with_capacity(handles.len());
    for handle in handles {
        if let Ok(Some((ip, name))) = handle.await {
            out.insert(ip, name);
        }
    }
    out
}

/// True if `ip` falls within any (network, mask) range.
fn ip_in_ranges(ip: Ipv4Addr, ranges: &[(u32, u32)]) -> bool {
    let v = u32::from(ip);
    ranges.iter().any(|(net, mask)| v & mask == *net)
}

/// Progress bookkeeping shared by the probe tasks.
#[derive(Default)]
struct Counters {
    done: AtomicUsize,
    probed: AtomicUsize,
    found: AtomicUsize,
}

impl Counters {
    /// Throttle progress events to roughly 100 per scan plus the final one, so
    /// a 65k-address sweep does not push 65k messages through the event bridge.
    fn should_report(&self, done: usize, total: usize) -> bool {
        let step = (total / 100).max(1);
        done == total || done % step == 0
    }
}

/// A MAC covering more than this share of the scanned range is a proxy-ARP
/// responder rather than a device.
fn proxy_threshold(scanned: usize) -> usize {
    (scanned / 16).max(8)
}

fn proxy_frequencies(
    arp: &HashMap<Ipv4Addr, String>,
    scanned: impl Iterator<Item = Ipv4Addr>,
) -> HashMap<String, usize> {
    let mut freq: HashMap<String, usize> = HashMap::new();
    for ip in scanned {
        if let Some(mac) = arp.get(&ip) {
            *freq.entry(mac.clone()).or_default() += 1;
        }
    }
    freq
}

/// True when `ip` has an ARP entry belonging to a real device rather than to a
/// proxy-ARP responder.
fn is_real_mac(
    arp: &HashMap<Ipv4Addr, String>,
    freq: &HashMap<String, usize>,
    threshold: usize,
    ip: &Ipv4Addr,
) -> bool {
    arp.get(ip)
        .is_some_and(|mac| freq.get(mac).copied().unwrap_or(0) <= threshold)
}

/// Decide whether one probed address belongs in the final device set.
///
/// ARP is strong evidence when it positively identifies a real local MAC, and a
/// proxy-ARP entry is strong evidence that an apparent device is a router
/// artefact. The *absence* of an ARP entry is different: neighbour caches are
/// transient, so a missing entry must never erase a device that already proved
/// it was alive over ICMP or TCP.
fn should_keep_probe(
    ip: &Ipv4Addr,
    probe: &Probe,
    own_ips: &HashSet<Ipv4Addr>,
    arp_authoritative: bool,
    arp: &HashMap<Ipv4Addr, String>,
    mac_freq: &HashMap<String, usize>,
    threshold: usize,
) -> bool {
    if own_ips.contains(ip) {
        return true;
    }
    if !arp_authoritative {
        return probe.up;
    }
    if is_real_mac(arp, mac_freq, threshold, ip) {
        return true;
    }
    if arp.contains_key(ip) {
        // An entry exists, but its MAC was classified as a proxy responder.
        return false;
    }
    probe.up
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Probe {
    up: bool,
    open_ports: Vec<u16>,
    icmp_ms: Option<f64>,
    tcp_ms: Option<f64>,
    ttl: Option<u8>,
}

impl Probe {
    fn dead() -> Self {
        Probe {
            up: false,
            open_ports: Vec::new(),
            icmp_ms: None,
            tcp_ms: None,
            ttl: None,
        }
    }
}

/// Build a `tokio::process::Command` that never pops a console window on
/// Windows.
///
/// EXP IP Scanner is a GUI app, so every child process it spawns -- `ping`,
/// `arp`, the launch helpers -- must carry CREATE_NO_WINDOW, or a /24 scan
/// would flash hundreds of console windows across the technician's desktop.
pub fn quiet_command(program: &str) -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut std_cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    tokio::process::Command::from(std_cmd)
}

/// Re-trigger ARP resolution for one address without caring about the result.
///
/// Any outgoing packet forces the OS to ARP-resolve its destination first, so a
/// second round of connects -- plus a ping, for a device that filters every TCP
/// port -- repopulates the neighbour cache for devices that were slow or lossy
/// on the first pass. A discovery aid only: nothing is read back here.
async fn arp_prime(
    ip: Ipv4Addr,
    ports: &[u16],
    per_probe: Duration,
    tcp_sem: Arc<Semaphore>,
    ping_sem: Arc<Semaphore>,
) {
    let subset: Vec<u16> = ports.iter().copied().take(4).collect();
    let tcp = async {
        stream::iter(subset)
            .map(|port| {
                let tcp_sem = Arc::clone(&tcp_sem);
                async move {
                    let _ = tcp_probe(ip, port, per_probe, tcp_sem).await;
                }
            })
            .buffer_unordered(4)
            .collect::<Vec<()>>()
            .await;
    };
    let ping = async {
        let _ = icmp_ping(ip, per_probe, ping_sem).await;
    };
    futures::join!(tcp, ping);
}

/// Probe one address: one ICMP echo plus a bounded TCP fan-out across the
/// selected ports. Both kinds of probe take a permit from their own global
/// semaphore, so the totals stay bounded however many hosts are in flight.
async fn probe_host(
    ip: Ipv4Addr,
    ports: &[u16],
    per_probe: Duration,
    fanout: usize,
    tcp_sem: Arc<Semaphore>,
    ping_sem: Arc<Semaphore>,
) -> Probe {
    let ping_fut = icmp_ping(ip, per_probe, ping_sem);
    let tcp_fut = async {
        stream::iter(ports.iter().copied())
            .map(|port| {
                let tcp_sem = Arc::clone(&tcp_sem);
                async move { (port, tcp_probe(ip, port, per_probe, tcp_sem).await) }
            })
            .buffer_unordered(fanout.min(ports.len().max(1)))
            .collect::<Vec<_>>()
            .await
    };

    let (ping_reply, tcp_results) = futures::join!(ping_fut, tcp_fut);

    let mut open_ports = Vec::new();
    let mut tcp_ms: Option<f64> = None;
    let mut alive_via_tcp = false;
    let note = |ms: f64, best: &mut Option<f64>| {
        *best = Some(best.map_or(ms, |b: f64| b.min(ms)));
    };

    for (port, state) in tcp_results {
        match state {
            PortState::Open(d) => {
                open_ports.push(port);
                alive_via_tcp = true;
                note(millis(d), &mut tcp_ms);
            }
            // A refused connection (RST) proves the host is alive even though
            // the port is closed. Throwing that away would lose every hardened
            // Windows box on the network.
            PortState::Refused(d) => {
                alive_via_tcp = true;
                note(millis(d), &mut tcp_ms);
            }
            PortState::NoReply => {}
        }
    }

    open_ports.sort_unstable();
    Probe {
        up: ping_reply.is_some() || alive_via_tcp,
        open_ports,
        icmp_ms: ping_reply.as_ref().map(|r| r.rtt_ms),
        tcp_ms,
        ttl: ping_reply.and_then(|r| r.ttl),
    }
}

/// Duration as fractional milliseconds, rounded to two decimals so a
/// sub-millisecond wired response stays meaningful without noisy precision.
fn millis(d: Duration) -> f64 {
    (d.as_secs_f64() * 100_000.0).round() / 100.0
}

struct PingReply {
    rtt_ms: f64,
    ttl: Option<u8>,
}

enum PortState {
    Open(Duration),
    Refused(Duration),
    NoReply,
}

/// Map an observed TTL onto a coarse family.
///
/// On a LAN the reply TTL is the sender's initial TTL minus a hop or two: ~64
/// is Linux/Unix/macOS, ~128 is Windows, above that is usually network gear.
/// Presented as a hint and never as a fact, because a single TTL is genuinely
/// not enough to identify an operating system and pretending otherwise would
/// send a technician down the wrong path.
fn os_hint_from_ttl(ttl: u8) -> Option<String> {
    let label = if (33..=64).contains(&ttl) {
        "Linux / Unix / macOS"
    } else if (65..=128).contains(&ttl) {
        "Windows"
    } else if ttl > 128 {
        "Network device"
    } else {
        return None;
    };
    Some(label.to_string())
}

/// Parse the TTL out of a `ping` reply line (case-insensitive `ttl=NN`).
fn parse_ttl(output: &str) -> Option<u8> {
    let lower = output.to_ascii_lowercase();
    let idx = lower.find("ttl=")?;
    let rest = &lower[idx + 4..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// Parse the round-trip time `ping` itself reports, which is the real ICMP
/// latency rather than how long the child process took to start, run and exit.
///
/// Handles the formats the supported platforms produce:
///
/// * Windows: `Reply from 10.0.0.1: bytes=32 time=3ms TTL=64`, and `time<1ms`
///   for a sub-millisecond reply.
/// * Linux and macOS: `64 bytes from 10.0.0.1: icmp_seq=0 ttl=64 time=0.443 ms`
///
/// Returns `None` for localised or unexpected output, so the caller falls back
/// to the measured process duration instead of reporting a wrong number.
fn parse_rtt_ms(output: &str) -> Option<f64> {
    let lower = output.to_ascii_lowercase();
    let idx = lower.find("time")?;
    let rest = lower[idx + 4..].trim_start();
    let rest = rest.strip_prefix('=').or_else(|| rest.strip_prefix('<'))?;
    let digits: String = rest
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let value: f64 = digits.parse().ok()?;
    value.is_finite().then_some(value)
}

async fn tcp_probe(
    ip: Ipv4Addr,
    port: u16,
    per_probe: Duration,
    tcp_sem: Arc<Semaphore>,
) -> PortState {
    // The permit is taken *before* the socket is created, so the number of
    // simultaneous connection attempts across the whole scan never exceeds the
    // configured ceiling. This is the line that prevents socket exhaustion.
    let Ok(_permit) = tcp_sem.acquire().await else {
        return PortState::NoReply;
    };
    let addr = SocketAddr::new(IpAddr::V4(ip), port);
    let start = Instant::now();
    match timeout(per_probe, tokio::net::TcpStream::connect(addr)).await {
        Ok(Ok(_stream)) => PortState::Open(start.elapsed()),
        Ok(Err(e)) => match e.kind() {
            std::io::ErrorKind::ConnectionRefused => PortState::Refused(start.elapsed()),
            _ => PortState::NoReply,
        },
        Err(_) => PortState::NoReply,
    }
}

/// ICMP echo through the OS `ping` binary.
///
/// Deliberately not a raw socket: that would need administrator rights, and a
/// scanner a technician cannot run on a locked-down laptop is not a scanner.
/// The reply is captured so the TTL and the reported round-trip time can be
/// read. Requiring a `ttl=` marker also filters out the Windows quirk where
/// `ping` exits 0 on a "Destination host unreachable" reply from a router.
async fn icmp_ping(
    ip: Ipv4Addr,
    per_probe: Duration,
    ping_sem: Arc<Semaphore>,
) -> Option<PingReply> {
    // Child processes are the most expensive thing a scan does, so they get the
    // tightest global limit. Without it a wide sweep spawns hundreds at once.
    let _permit = ping_sem.acquire().await.ok()?;

    let ms = per_probe.as_millis().max(1);
    let ip_s = ip.to_string();
    let start = Instant::now();

    let mut cmd = quiet_command("ping");
    #[cfg(windows)]
    {
        // -n 1: one echo. -w <ms>: reply timeout in milliseconds.
        cmd.args(["-n", "1", "-w", &ms.to_string(), &ip_s]);
    }
    #[cfg(target_os = "macos")]
    {
        // Keep it numeric: macOS `ping` otherwise performs name lookups that can
        // outlive the ICMP reply and make a responsive device look silent.
        let secs = ms.div_ceil(1000).max(1);
        cmd.args([
            "-n",
            "-c",
            "1",
            "-o",
            "-W",
            &ms.to_string(),
            "-t",
            &secs.to_string(),
            &ip_s,
        ]);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Linux/BSD: -c 1 count, -W <sec> reply timeout, -n numeric.
        let secs = ms.div_ceil(1000).max(1);
        cmd.args(["-c", "1", "-n", "-W", &secs.to_string(), &ip_s]);
    }

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());
    cmd.stdin(std::process::Stdio::null());

    // A slightly larger outer timeout, to guard against a hung `ping`.
    let outer = per_probe + Duration::from_millis(500);
    match timeout(outer, cmd.output()).await {
        Ok(Ok(out)) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout);
            if !text.to_ascii_lowercase().contains("ttl=") {
                return None;
            }
            Some(PingReply {
                // Prefer the RTT `ping` reports: process startup and exit add
                // several milliseconds on every platform, so the measured
                // duration is only a fallback for output that will not parse.
                rtt_ms: parse_rtt_ms(&text).unwrap_or_else(|| millis(start.elapsed())),
                ttl: parse_ttl(&text),
            })
        }
        _ => None,
    }
}

/// One ICMP echo for the Ping action, outside any scan.
///
/// Shares `icmp_ping` rather than shelling out separately, so the latency a
/// technician sees from the Ping button is measured exactly the way the Latency
/// column is. Returns the round-trip time and the TTL, or `None` for no reply.
pub async fn ping_for_action(ip: Ipv4Addr, timeout: Duration) -> Option<(f64, Option<u8>)> {
    // Its own single-permit semaphore: an action ping is one process and must
    // not be queued behind, or counted against, a running scan's budget.
    let sem = Arc::new(Semaphore::new(1));
    let reply = icmp_ping(ip, timeout, sem).await?;
    Some((reply.rtt_ms, reply.ttl))
}

/// Reverse-DNS one address with a short timeout, on a blocking thread because
/// `dns_lookup` is synchronous.
async fn resolve_hostname(ip: Ipv4Addr) -> Option<String> {
    let fut = tokio::task::spawn_blocking(move || dns_lookup::lookup_addr(&IpAddr::V4(ip)).ok());
    match timeout(Duration::from_millis(1500), fut).await {
        Ok(Ok(Some(name))) => {
            let name = name.trim().trim_end_matches('.').to_string();
            // A resolver that just echoes the address back has told us nothing.
            if name.is_empty() || name == ip.to_string() {
                None
            } else {
                Some(name)
            }
        }
        _ => None,
    }
}

/// Read the system ARP cache in one OS call and map IPv4 -> normalised MAC.
async fn read_arp_cache() -> HashMap<Ipv4Addr, String> {
    let mut cmd = quiet_command("arp");
    #[cfg(windows)]
    cmd.arg("-a");
    // BSD and macOS `arp` try to resolve every address symbolically without
    // -n. On a populated /24 that can exceed this timeout and throw away the
    // entire neighbour table, leaving only the ICMP/TCP responders in the
    // result. Numeric output is both faster and exactly what is parsed below.
    #[cfg(not(windows))]
    cmd.args(["-n", "-a"]);
    cmd.stdin(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    let output = match timeout(Duration::from_secs(5), cmd.output()).await {
        Ok(Ok(o)) => o,
        _ => return HashMap::new(),
    };
    parse_arp(&String::from_utf8_lossy(&output.stdout))
}

/// Parse `arp -a` output across platforms.
///
/// Windows prints a column layout with `-` separators; unix prints
/// `host (ip) at mac`. Rather than two parsers, each line is scanned for an
/// IPv4-looking token and a MAC-looking token, which handles both and survives
/// the localised column headings Windows prints.
fn parse_arp(text: &str) -> HashMap<Ipv4Addr, String> {
    let mut map = HashMap::new();
    for line in text.lines() {
        let mut ip: Option<Ipv4Addr> = None;
        let mut mac: Option<String> = None;
        for raw in line.split(|c: char| c.is_whitespace() || c == '(' || c == ')') {
            let tok = raw.trim();
            if tok.is_empty() {
                continue;
            }
            if ip.is_none() {
                if let Ok(parsed) = tok.parse::<Ipv4Addr>() {
                    ip = Some(parsed);
                    continue;
                }
            }
            if mac.is_none() {
                if let Some(normalized) = normalize_mac(tok) {
                    mac = Some(normalized);
                }
            }
        }
        if let (Some(ip), Some(mac)) = (ip, mac) {
            map.insert(ip, mac);
        }
    }
    map
}

/// Normalise a MAC token into uppercase colon-separated form.
///
/// macOS `arp -a` prints unpadded octets (`a0:ce:c8:d:cf:d1`), so single-digit
/// groups are zero-padded. Returns `None` for anything that is not a MAC,
/// including the broadcast and all-zero addresses, which are table artefacts
/// rather than devices.
pub fn normalize_mac(tok: &str) -> Option<String> {
    let sep = if tok.contains('-') {
        '-'
    } else if tok.contains(':') {
        ':'
    } else {
        return None;
    };
    let parts: Vec<&str> = tok.split(sep).collect();
    if parts.len() != 6 {
        return None;
    }
    let mut octets = Vec::with_capacity(6);
    for p in parts {
        if p.is_empty() || p.len() > 2 || !p.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        octets.push(format!("{:0>2}", p.to_ascii_uppercase()));
    }
    let mac = octets.join(":");
    if mac == "FF:FF:FF:FF:FF:FF" || mac == "00:00:00:00:00:00" {
        return None;
    }
    Some(mac)
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Scans share process-wide cancellation state and the checkpoint hook, so
    /// the tests that run one take this lock. An async mutex, because the guard
    /// is held across the scan's own await points. Everything else in this
    /// module is pure and runs in parallel.
    static SCAN_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn set_checkpoint_hook(hook: impl Fn(Checkpoint) + Send + 'static) {
        *CHECKPOINT_HOOK.lock().unwrap() = Some(Box::new(hook));
    }

    fn clear_checkpoint_hook() {
        *CHECKPOINT_HOOK.lock().unwrap() = None;
    }

    fn arp_map(pairs: &[(&str, &str)]) -> HashMap<Ipv4Addr, String> {
        pairs
            .iter()
            .map(|(ip, mac)| (ip.parse().unwrap(), (*mac).to_string()))
            .collect()
    }

    fn hosts(list: &[&str]) -> Vec<Ipv4Addr> {
        list.iter().map(|s| s.parse().unwrap()).collect()
    }

    fn range(base: &str, prefix: u32) -> (u32, u32) {
        let mask = u32::MAX << (32 - prefix);
        (u32::from(base.parse::<Ipv4Addr>().unwrap()) & mask, mask)
    }

    fn live(ports: &[u16]) -> Probe {
        Probe {
            up: true,
            open_ports: ports.to_vec(),
            icmp_ms: Some(1.0),
            tcp_ms: None,
            ttl: Some(128),
        }
    }

    // --- ARP parsing ------------------------------------------------------

    #[test]
    fn parses_windows_arp_output() {
        let sample = "\nInterface: 192.168.1.10 --- 0x5\n  Internet Address      Physical Address      Type\n  192.168.1.1           a0-11-22-33-44-55     dynamic\n  192.168.1.20          00-1a-2b-3c-4d-5e     dynamic\n  192.168.1.255         ff-ff-ff-ff-ff-ff     static\n";
        let map = parse_arp(sample);
        assert_eq!(
            map.get(&"192.168.1.1".parse().unwrap()).map(String::as_str),
            Some("A0:11:22:33:44:55")
        );
        assert_eq!(map.len(), 2, "the broadcast row must not become a device");
    }

    #[test]
    fn parses_unix_arp_output() {
        let sample = "router.lan (192.168.0.1) at 3c:37:86:aa:bb:cc [ether] on eth0\n? (192.168.0.44) at 00:1a:2b:3c:4d:5e [ether] on eth0\n? (192.168.0.99) at <incomplete> on eth0\n";
        let map = parse_arp(sample);
        assert_eq!(
            map.get(&"192.168.0.1".parse().unwrap()).map(String::as_str),
            Some("3C:37:86:AA:BB:CC")
        );
        assert_eq!(map.len(), 2, "an incomplete entry is not a device");
    }

    #[test]
    fn parses_macos_unpadded_macs() {
        let sample = "gateway.lan (10.0.1.1) at a0:ce:c8:d:cf:d1 on en0 ifscope [ethernet]\n";
        let map = parse_arp(sample);
        assert_eq!(
            map.get(&"10.0.1.1".parse().unwrap()).map(String::as_str),
            Some("A0:CE:C8:0D:CF:D1")
        );
    }

    #[test]
    fn normalizes_and_rejects_mac_tokens() {
        assert_eq!(
            normalize_mac("00-1a-2b-3c-4d-5e").as_deref(),
            Some("00:1A:2B:3C:4D:5E")
        );
        assert_eq!(
            normalize_mac("0:1a:2b:3c:4d:5e").as_deref(),
            Some("00:1A:2B:3C:4D:5E")
        );
        for bad in [
            "",
            "dynamic",
            "192.168.1.1",
            "00:1a:2b:3c:4d",
            "00:1a:2b:3c:4d:5e:6f",
            "zz:zz:zz:zz:zz:zz",
            "ff-ff-ff-ff-ff-ff",
            "00:00:00:00:00:00",
            "<incomplete>",
        ] {
            assert_eq!(normalize_mac(bad), None, "accepted {bad:?}");
        }
    }

    // --- Proxy ARP --------------------------------------------------------

    #[test]
    fn a_mac_covering_the_range_is_treated_as_a_proxy_responder() {
        // A client-isolated access point answering ARP for its whole /24.
        let scanned = (1..=254)
            .map(|n| Ipv4Addr::new(192, 168, 1, n))
            .collect::<Vec<_>>();
        let arp: HashMap<Ipv4Addr, String> = scanned
            .iter()
            .map(|ip| (*ip, "AA:BB:CC:DD:EE:FF".to_string()))
            .collect();
        let freq = proxy_frequencies(&arp, scanned.iter().copied());
        let threshold = proxy_threshold(scanned.len());
        assert!(!is_real_mac(&arp, &freq, threshold, &scanned[0]));

        // One genuine device on the same segment is still a device.
        let mut mixed = arp.clone();
        mixed.insert(Ipv4Addr::new(192, 168, 1, 50), "11:22:33:44:55:66".into());
        let freq = proxy_frequencies(&mixed, scanned.iter().copied());
        assert!(is_real_mac(
            &mixed,
            &freq,
            threshold,
            &Ipv4Addr::new(192, 168, 1, 50)
        ));
    }

    #[test]
    fn a_gateway_answering_for_itself_is_not_a_proxy() {
        let scanned = hosts(&["192.168.1.1", "192.168.1.20", "192.168.1.21"]);
        let arp = arp_map(&[
            ("192.168.1.1", "AA:BB:CC:00:00:01"),
            ("192.168.1.20", "AA:BB:CC:00:00:02"),
        ]);
        let freq = proxy_frequencies(&arp, scanned.iter().copied());
        let threshold = proxy_threshold(scanned.len());
        assert!(is_real_mac(&arp, &freq, threshold, &scanned[0]));
        assert!(is_real_mac(&arp, &freq, threshold, &scanned[1]));
        assert!(!is_real_mac(&arp, &freq, threshold, &scanned[2]));
    }

    // --- Keeping and dropping devices -------------------------------------

    #[test]
    fn a_silent_device_with_a_real_mac_is_kept() {
        // The printer that ignores ICMP and filters every port. ARP is how it
        // gets found at all, and this is the case that makes the second pass
        // worth having.
        let ip: Ipv4Addr = "192.168.1.77".parse().unwrap();
        let arp = arp_map(&[("192.168.1.77", "00:80:77:11:22:33")]);
        let scanned = [ip];
        let freq = proxy_frequencies(&arp, scanned.iter().copied());
        assert!(should_keep_probe(
            &ip,
            &Probe::dead(),
            &HashSet::new(),
            true,
            &arp,
            &freq,
            proxy_threshold(1),
        ));
    }

    #[test]
    fn a_proxy_arp_entry_removes_an_apparent_device() {
        let scanned: Vec<Ipv4Addr> = (1..=254).map(|n| Ipv4Addr::new(10, 0, 0, n)).collect();
        let arp: HashMap<Ipv4Addr, String> = scanned
            .iter()
            .map(|ip| (*ip, "AA:BB:CC:DD:EE:FF".to_string()))
            .collect();
        let freq = proxy_frequencies(&arp, scanned.iter().copied());
        assert!(!should_keep_probe(
            &scanned[9],
            &Probe::dead(),
            &HashSet::new(),
            true,
            &arp,
            &freq,
            proxy_threshold(scanned.len()),
        ));
    }

    #[test]
    fn a_missing_arp_entry_never_erases_positive_icmp_or_tcp_evidence() {
        // Neighbour caches are transient. Absence of an entry is missing
        // enrichment, not proof that a device that answered does not exist.
        let ip: Ipv4Addr = "192.168.1.31".parse().unwrap();
        let empty = HashMap::new();
        assert!(should_keep_probe(
            &ip,
            &live(&[445]),
            &HashSet::new(),
            true,
            &empty,
            &HashMap::new(),
            8,
        ));
    }

    #[test]
    fn this_machine_is_always_kept() {
        let ip: Ipv4Addr = "192.168.1.5".parse().unwrap();
        let own: HashSet<Ipv4Addr> = [ip].into_iter().collect();
        assert!(should_keep_probe(
            &ip,
            &Probe::dead(),
            &own,
            true,
            &HashMap::new(),
            &HashMap::new(),
            8,
        ));
    }

    #[test]
    fn a_routed_target_is_judged_on_probe_evidence_alone() {
        let ip: Ipv4Addr = "203.0.113.9".parse().unwrap();
        let empty = HashMap::new();
        assert!(should_keep_probe(
            &ip,
            &live(&[443]),
            &HashSet::new(),
            false,
            &empty,
            &HashMap::new(),
            8
        ));
        assert!(!should_keep_probe(
            &ip,
            &Probe::dead(),
            &HashSet::new(),
            false,
            &empty,
            &HashMap::new(),
            8
        ));
    }

    #[test]
    fn range_containment_is_exact() {
        let ranges = [range("192.168.0.0", 24)];
        assert!(ip_in_ranges(Ipv4Addr::new(192, 168, 0, 5), &ranges));
        assert!(ip_in_ranges(Ipv4Addr::new(192, 168, 0, 254), &ranges));
        assert!(!ip_in_ranges(Ipv4Addr::new(192, 168, 1, 5), &ranges));
        assert!(!ip_in_ranges(Ipv4Addr::new(10, 0, 0, 1), &ranges));
    }

    // --- Ping output parsing ----------------------------------------------

    #[test]
    fn reads_the_ttl_from_every_supported_platform() {
        assert_eq!(
            parse_ttl("Reply from 10.0.0.1: bytes=32 time=3ms TTL=128"),
            Some(128)
        );
        assert_eq!(
            parse_ttl("64 bytes from 10.0.0.1: icmp_seq=0 ttl=64 time=0.443 ms"),
            Some(64)
        );
        assert_eq!(parse_ttl("no reply at all"), None);
    }

    #[test]
    fn reads_the_round_trip_time_from_every_supported_platform() {
        assert_eq!(
            parse_rtt_ms("Reply from 10.0.0.1: bytes=32 time=3ms TTL=128"),
            Some(3.0)
        );
        assert_eq!(
            parse_rtt_ms("Reply from 10.0.0.1: bytes=32 time<1ms TTL=128"),
            Some(1.0)
        );
        assert_eq!(
            parse_rtt_ms("64 bytes from 10.0.0.1: icmp_seq=0 ttl=64 time=0.443 ms"),
            Some(0.443)
        );
        // Localised or unexpected output falls back rather than reporting a
        // number it did not read.
        assert_eq!(parse_rtt_ms("Antwort von 10.0.0.1: Zeit=1ms TTL=64"), None);
        assert_eq!(parse_rtt_ms(""), None);
    }

    #[test]
    fn the_os_hint_is_coarse_and_honest() {
        assert_eq!(
            os_hint_from_ttl(64).as_deref(),
            Some("Linux / Unix / macOS")
        );
        assert_eq!(os_hint_from_ttl(128).as_deref(), Some("Windows"));
        assert_eq!(os_hint_from_ttl(118).as_deref(), Some("Windows"));
        assert_eq!(os_hint_from_ttl(255).as_deref(), Some("Network device"));
        // Too few hops left to say anything at all.
        assert_eq!(os_hint_from_ttl(5), None);
    }

    // --- Planning ---------------------------------------------------------

    #[test]
    fn a_default_slash_24_is_planned_without_a_warning() {
        let plan = plan(&ScanOptions::for_target("192.168.1.0/24")).unwrap();
        assert_eq!(plan.hosts.len(), 254);
        assert_eq!(plan.ports, ports::DEFAULT_PORTS.to_vec());
        assert_eq!(plan.workload, 254 * ports::DEFAULT_PORTS.len() as u64);
        assert!(plan.warning.is_none(), "{:?}", plan.warning);
    }

    #[test]
    fn a_large_but_legal_scan_warns_instead_of_refusing() {
        let plan = plan(&ScanOptions::for_target("10.0.0.0/16")).unwrap();
        let warning = plan.warning.expect("a /16 sweep should be flagged");
        assert!(warning.contains("Large scan"), "{warning}");
        assert!(
            warning.contains(','),
            "numbers should be grouped: {warning}"
        );
    }

    #[test]
    fn a_scan_past_the_workload_budget_is_refused_with_the_numbers() {
        let mut opts = ScanOptions::for_target("10.0.0.0/16");
        opts.ports = (1..=1024).collect();
        let err = plan(&opts).unwrap_err();
        assert!(err.contains("connection attempts"), "{err}");
        assert!(err.contains("65,534"), "{err}");
    }

    #[test]
    fn turning_service_detection_off_still_probes_for_liveness() {
        let mut opts = ScanOptions::for_target("192.168.1.0/24");
        opts.scan_services = false;
        // Even a port list the technician left behind is ignored, so the
        // setting means what it says.
        opts.ports = (1..=500).collect();
        let plan = plan(&opts).unwrap();
        assert_eq!(plan.ports, LIVENESS_PORTS.to_vec());
        assert!(
            !plan.ports.is_empty(),
            "a ping-only sweep would miss quiet devices"
        );
    }

    #[test]
    fn a_bad_target_is_refused_before_anything_is_sent() {
        assert!(plan(&ScanOptions::for_target("not-a-network")).is_err());
        assert!(plan(&ScanOptions::for_target("")).is_err());
        assert!(plan(&ScanOptions::for_target("10.0.0.0/8")).is_err());
    }

    #[test]
    fn limits_are_clamped_into_ranges_the_app_can_sustain() {
        let mut opts = ScanOptions::for_target("10.0.0.1");
        opts.concurrency = 100_000;
        opts.tcp_concurrency = Some(1_000_000);
        opts.ping_concurrency = Some(0);
        let limits = opts.limits();
        assert_eq!(limits.host_concurrency, 512);
        assert_eq!(limits.tcp_concurrency, 1_024);
        assert_eq!(limits.ping_concurrency, 1);

        opts.concurrency = 0;
        assert_eq!(opts.limits().host_concurrency, 1);
    }

    #[test]
    fn the_timeout_is_clamped_rather_than_trusted() {
        let mut opts = ScanOptions::for_target("10.0.0.1");
        opts.timeout_ms = 0;
        assert_eq!(plan(&opts).unwrap().timeout, Duration::from_millis(50));
        opts.timeout_ms = 10_000_000;
        assert_eq!(plan(&opts).unwrap().timeout, Duration::from_millis(10_000));
    }

    #[test]
    fn per_host_fanout_scales_with_the_work_available() {
        let limits = ScanLimits::default();
        // One host: let it use a real share of the global budget.
        assert!(limits.per_host_fanout(1) >= 64);
        // A wide sweep: a small share each, so the pending-future queue stays
        // proportional to the global ceiling rather than to hosts times ports.
        let wide = limits.per_host_fanout(254);
        assert!((4..=8).contains(&wide), "fanout for a /24 was {wide}");
    }

    #[test]
    fn progress_events_are_throttled_to_about_a_hundred_per_scan() {
        let counters = Counters::default();
        let total = 65_534;
        let reported = (1..=total)
            .filter(|d| counters.should_report(*d, total))
            .count();
        assert!(
            reported <= 110,
            "{reported} progress events for {total} addresses"
        );
        assert!(
            counters.should_report(total, total),
            "the final event must be sent"
        );

        // A tiny scan still reports every address.
        assert!((1..=5).all(|d| counters.should_report(d, 5)));
    }

    #[test]
    fn large_numbers_are_grouped_for_reading() {
        assert_eq!(thousands(0), "0");
        assert_eq!(thousands(999), "999");
        assert_eq!(thousands(1_000), "1,000");
        assert_eq!(thousands(65_534), "65,534");
        assert_eq!(thousands(3_000_000), "3,000,000");
    }

    // --- End to end -------------------------------------------------------

    /// A real scan against a listener this test owns.
    ///
    /// No ping and no ARP entry are required for it to pass, so it is
    /// deterministic on any machine and in any container: a TCP connect that
    /// completes is itself proof of life, which is exactly the path that finds
    /// devices ignoring ICMP.
    #[tokio::test]
    async fn finds_a_device_that_only_answers_on_tcp() {
        let _guard = SCAN_TEST_LOCK.lock().await;
        clear_checkpoint_hook();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let mut opts = ScanOptions::for_target("127.0.0.1");
        opts.ports = vec![port];
        opts.resolve_hostnames = false;
        opts.timeout_ms = 1_500;

        let (tx, mut rx) = tokio::sync::mpsc::channel(EVENT_CHANNEL_CAPACITY);
        let scan_id = next_scan_id();
        let result = run(opts, scan_id, Some(tx)).await.unwrap();

        assert!(!result.cancelled);
        assert_eq!(result.scanned, 1);
        assert_eq!(result.probed, 1);
        assert_eq!(result.ports, vec![port]);
        let host = result
            .hosts
            .iter()
            .find(|h| h.ip == "127.0.0.1")
            .expect("the listener's address should be reported");
        assert!(host.open_ports.contains(&port), "{:?}", host.open_ports);
        assert!(host.latency_ms.is_some(), "an answered probe has a latency");

        // The stream said the same thing the result does.
        let mut streamed_started = false;
        let mut streamed_ports: Option<Vec<u16>> = None;
        let mut final_phase = None;
        while let Ok(event) = rx.try_recv() {
            match event {
                ScanEvent::Started(s) => {
                    assert_eq!(s.scan_id, scan_id);
                    assert_eq!(s.total, 1);
                    streamed_started = true;
                }
                ScanEvent::HostDiscovered { host, .. } | ScanEvent::HostUpdated { host, .. } => {
                    streamed_ports = Some(host.open_ports.clone());
                }
                ScanEvent::Progress(p) => final_phase = Some(p.phase),
                ScanEvent::HostRemoved { .. } => panic!("a real device was withdrawn"),
            }
        }
        assert!(streamed_started, "no started event reached the interface");
        assert_eq!(streamed_ports.as_deref(), Some(&[port][..]));
        assert_eq!(final_phase, Some(ScanPhase::Done));
    }

    /// A closed port still proves the address is alive, because the refusal
    /// came from a host.
    #[tokio::test]
    async fn a_refused_connection_counts_as_proof_of_life() {
        let _guard = SCAN_TEST_LOCK.lock().await;
        clear_checkpoint_hook();

        // Bind and immediately drop, so the port is very likely closed while
        // loopback still refuses rather than dropping the packet.
        let closed = {
            let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };

        let mut opts = ScanOptions::for_target("127.0.0.1");
        opts.ports = vec![closed];
        opts.resolve_hostnames = false;
        opts.timeout_ms = 1_500;

        let result = run(opts, next_scan_id(), None).await.unwrap();
        let host = result.hosts.iter().find(|h| h.ip == "127.0.0.1");
        if let Some(host) = host {
            assert!(
                host.open_ports.is_empty(),
                "a refused port is not an open port: {:?}",
                host.open_ports
            );
            assert!(host.latency_ms.is_some());
        }
        // If loopback silently dropped the SYN there is nothing to assert, and
        // asserting anyway would be a flake rather than a test.
    }

    /// Stop is honoured immediately, and the scan still returns.
    #[tokio::test]
    async fn stopping_a_scan_ends_it_promptly_and_reports_it_as_cancelled() {
        let _guard = SCAN_TEST_LOCK.lock().await;

        // Cancel at the first checkpoint, before a single probe is sent. The
        // target is TEST-NET-3, which is reserved for documentation and must
        // not answer.
        set_checkpoint_hook(|cp| {
            if cp == Checkpoint::BeforeProbing {
                request_cancel();
            }
        });

        let mut opts = ScanOptions::for_target("203.0.113.0/24");
        opts.resolve_hostnames = false;
        opts.timeout_ms = 2_000;

        let started = Instant::now();
        let result = run(opts, next_scan_id(), None).await.unwrap();
        let elapsed = started.elapsed();
        clear_checkpoint_hook();

        assert!(result.cancelled, "the scan should report itself cancelled");
        assert_eq!(result.scanned, 254, "the target's size is still reported");
        assert_eq!(result.probed, 0, "no address should have been probed");
        assert!(
            elapsed < Duration::from_secs(10),
            "stopping took {elapsed:?}; the remaining addresses were not drained"
        );
    }

    /// A stop that lands after probing still keeps everything already found.
    #[tokio::test]
    async fn a_late_stop_keeps_the_devices_already_discovered() {
        let _guard = SCAN_TEST_LOCK.lock().await;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        set_checkpoint_hook(|cp| {
            if cp == Checkpoint::AfterProbing {
                request_cancel();
            }
        });

        let mut opts = ScanOptions::for_target("127.0.0.1");
        opts.ports = vec![port];
        opts.resolve_hostnames = false;
        opts.timeout_ms = 1_500;

        let result = run(opts, next_scan_id(), None).await.unwrap();
        clear_checkpoint_hook();

        assert!(result.cancelled);
        assert_eq!(result.probed, 1);
        let host = result
            .hosts
            .iter()
            .find(|h| h.ip == "127.0.0.1")
            .expect("a device found before the stop must be kept");
        assert!(host.open_ports.contains(&port));
    }

    /// A stop requested for a previous scan must not cancel the next one.
    #[tokio::test]
    async fn a_stale_stop_does_not_cancel_the_following_scan() {
        let _guard = SCAN_TEST_LOCK.lock().await;
        clear_checkpoint_hook();

        // Leave a cancellation request behind from a scan that is over.
        ACTIVE_SCAN.store(4_242, Ordering::Relaxed);
        request_cancel();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut opts = ScanOptions::for_target("127.0.0.1");
        opts.ports = vec![port];
        opts.resolve_hostnames = false;

        let result = run(opts, next_scan_id(), None).await.unwrap();
        assert!(!result.cancelled, "a stale stop leaked into a new scan");
    }

    /// Events carry the id of the scan that produced them, which is what lets
    /// the interface drop anything belonging to a scan it is no longer showing.
    #[tokio::test]
    async fn every_event_carries_its_own_scan_id() {
        let _guard = SCAN_TEST_LOCK.lock().await;
        clear_checkpoint_hook();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut opts = ScanOptions::for_target("127.0.0.1");
        opts.ports = vec![port];
        opts.resolve_hostnames = false;

        let (tx, mut rx) = tokio::sync::mpsc::channel(EVENT_CHANNEL_CAPACITY);
        let scan_id = next_scan_id();
        run(opts, scan_id, Some(tx)).await.unwrap();

        let mut seen = 0;
        while let Ok(event) = rx.try_recv() {
            let id = match event {
                ScanEvent::Started(s) => s.scan_id,
                ScanEvent::Progress(p) => p.scan_id,
                ScanEvent::HostDiscovered { scan_id, .. }
                | ScanEvent::HostUpdated { scan_id, .. }
                | ScanEvent::HostRemoved { scan_id, .. } => scan_id,
            };
            assert_eq!(id, scan_id);
            seen += 1;
        }
        assert!(seen >= 3, "only {seen} events were streamed");
    }

    /// A scan with no listener attached must still finish cleanly: the window
    /// can be closed mid-scan, and the result is the source of truth anyway.
    #[tokio::test]
    async fn a_scan_with_no_event_receiver_still_completes() {
        let _guard = SCAN_TEST_LOCK.lock().await;
        clear_checkpoint_hook();

        let mut opts = ScanOptions::for_target("203.0.113.1");
        opts.ports = vec![9];
        opts.resolve_hostnames = false;
        opts.timeout_ms = 100;
        let result = run(opts, next_scan_id(), None).await.unwrap();
        assert_eq!(result.scanned, 1);
    }
}
