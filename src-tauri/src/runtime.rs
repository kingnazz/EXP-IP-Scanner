//! Which edition this binary is, and where it keeps its preferences.
//!
//! The edition is an explicit Cargo feature, never inferred at runtime from the
//! folder the executable happens to sit in. Inferring it would make the
//! location of a consultant's preferences depend on where they dropped the
//! file, which is a silent behaviour change waiting to happen.
//!
//! EXP IP Scanner has no database. Scan results live in memory for the life of
//! the window and are written to disk only when a consultant explicitly
//! exports a CSV. That is deliberate: the same copy of this tool is pointed at
//! many unrelated customer networks, and one customer's device list has no
//! business persisting into the next site visit. It is also what makes the
//! portable story simple -- there is no data store to relocate, clean up or
//! leave behind.

use std::fmt;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Sub-directory of the application's local data folder used by the portable
/// edition for its WebView profile.
///
/// The portable edition needs *a* writable profile directory, because WebView2
/// otherwise creates one beside the executable -- which would break running
/// from a read-only share, a USB stick or a synced OneDrive folder, all of
/// which are ordinary field workflows. So it uses the operating system's
/// per-user application data location, like any well-behaved Windows program,
/// and a distinct sub-directory so a portable copy and an installed copy can
/// run side by side without sharing preferences.
pub const PORTABLE_PROFILE_DIR: &str = "portable-webview";
/// Browser arguments needed when WebView2 is hosted by the Windows LocalSystem
/// account. ScreenConnect Backstage runs tools in that security context, while
/// WebView2 refuses SYSTEM hosts by default. Keep Tauri/wry's normal disabled
/// feature set when supplying our own arguments, then add Microsoft's explicit
/// SYSTEM override.
pub const SYSTEM_WEBVIEW2_BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --allow-run-as-system";

fn looks_like_windows_system_account(username: Option<&str>, userprofile: Option<&str>) -> bool {
    username.is_some_and(|value| value.eq_ignore_ascii_case("SYSTEM"))
        || userprofile.is_some_and(|value| {
            value
                .replace('/', "\\")
                .to_ascii_lowercase()
                .ends_with("\\windows\\system32\\config\\systemprofile")
        })
}

/// Whether this process is running as Windows LocalSystem.
///
/// Backstage sessions created by ScreenConnect run outside a normal user
/// desktop and commonly use LocalSystem. The environment check is intentionally
/// narrow: the browser flag does not grant SYSTEM privileges; it only lets
/// WebView2 start when the host process already has them.
pub fn running_as_windows_system() -> bool {
    if !cfg!(target_os = "windows") {
        return false;
    }

    let username = std::env::var("USERNAME").ok();
    let userprofile = std::env::var("USERPROFILE").ok();
    looks_like_windows_system_account(username.as_deref(), userprofile.as_deref())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Edition {
    Installed,
    Portable,
}

impl Edition {
    pub const fn current() -> Self {
        if cfg!(feature = "portable") {
            Edition::Portable
        } else {
            Edition::Installed
        }
    }

    pub const fn is_portable(self) -> bool {
        matches!(self, Edition::Portable)
    }

    pub const fn label(self) -> &'static str {
        match self {
            Edition::Installed => "Installed",
            Edition::Portable => "Portable",
        }
    }
}

impl fmt::Display for Edition {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Edition::Installed => "installed",
            Edition::Portable => "portable",
        })
    }
}

/// How this edition gets a new version.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateMode {
    /// The installed edition checks the signed GitHub feed and can install.
    Installer,
    /// The portable edition never self-updates: download the next ZIP.
    Manual,
}

impl UpdateMode {
    pub const fn current() -> Self {
        match Edition::current() {
            Edition::Installed => UpdateMode::Installer,
            Edition::Portable => UpdateMode::Manual,
        }
    }
}

pub const fn platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "Windows"
    } else if cfg!(target_os = "macos") {
        "macOS"
    } else if cfg!(target_os = "linux") {
        "Linux"
    } else {
        "Desktop"
    }
}

pub const fn architecture() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "ARM64"
    } else if cfg!(target_arch = "x86") {
        "x86"
    } else {
        "unknown"
    }
}

/// What the About panel shows, and what the interface uses to decide whether an
/// update button makes sense at all.
#[derive(Debug, Clone, Serialize)]
pub struct RuntimeInfo {
    pub version: String,
    pub edition: Edition,
    pub edition_label: String,
    pub platform: String,
    pub architecture: String,
    pub update_mode: UpdateMode,
}

/// The WebView profile directory this process should use, if it needs to name
/// one at all.
///
/// The installed edition returns `None` and keeps whatever Tauri would have
/// chosen, so nothing about it changes. The portable edition names a directory
/// under the per-user application data folder it was handed.
pub fn webview_profile_dir(local_data_dir: &Path) -> Option<PathBuf> {
    Edition::current()
        .is_portable()
        .then(|| local_data_dir.join(PORTABLE_PROFILE_DIR))
}

pub fn info() -> RuntimeInfo {
    let edition = Edition::current();
    RuntimeInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        edition,
        edition_label: edition.label().to_string(),
        platform: platform().to_string(),
        architecture: architecture().to_string(),
        update_mode: UpdateMode::current(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_edition_is_decided_at_compile_time() {
        // Whichever half of this is being built, the two views of it agree.
        assert_eq!(
            Edition::current().is_portable(),
            cfg!(feature = "portable"),
            "the edition does not match the feature it was built with"
        );
    }

    #[test]
    fn the_portable_edition_never_offers_an_installer_update() {
        match Edition::current() {
            Edition::Portable => assert_eq!(UpdateMode::current(), UpdateMode::Manual),
            Edition::Installed => assert_eq!(UpdateMode::current(), UpdateMode::Installer),
        }
    }

    #[test]
    fn only_the_portable_edition_names_its_own_profile_directory() {
        let root = Path::new("/local/app/data");
        match Edition::current() {
            Edition::Installed => assert_eq!(webview_profile_dir(root), None),
            Edition::Portable => assert_eq!(
                webview_profile_dir(root),
                Some(root.join(PORTABLE_PROFILE_DIR))
            ),
        }
    }

    #[test]
    fn a_portable_profile_is_never_placed_beside_the_executable() {
        // The whole point: the extracted folder stays read-only-safe.
        let root = Path::new("/local/app/data");
        if let Some(profile) = webview_profile_dir(root) {
            assert!(
                profile.starts_with(root),
                "{profile:?} escaped the data root"
            );
        }
    }

    #[test]
    fn system_account_detection_accepts_screenconnect_style_identity() {
        assert!(looks_like_windows_system_account(Some("SYSTEM"), None));
        assert!(looks_like_windows_system_account(
            Some("system"),
            Some(r"C:\\Windows\\System32\\config\\systemprofile")
        ));
        assert!(looks_like_windows_system_account(
            None,
            Some(r"C:\\Windows\\System32\\config\\systemprofile")
        ));
    }

    #[test]
    fn system_account_detection_rejects_normal_users() {
        assert!(!looks_like_windows_system_account(
            Some("consultant"),
            Some(r"C:\\Users\\consultant")
        ));
        assert!(!looks_like_windows_system_account(None, None));
    }

    #[test]
    fn system_webview_args_keep_wry_defaults_and_add_the_system_override() {
        assert!(SYSTEM_WEBVIEW2_BROWSER_ARGS.contains("msWebOOUI"));
        assert!(SYSTEM_WEBVIEW2_BROWSER_ARGS.contains("msPdfOOUI"));
        assert!(SYSTEM_WEBVIEW2_BROWSER_ARGS.contains("msSmartScreenProtection"));
        assert!(SYSTEM_WEBVIEW2_BROWSER_ARGS.contains("--allow-run-as-system"));
    }

    #[test]
    fn runtime_info_reports_the_built_version() {
        let info = info();
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
        assert!(!info.platform.is_empty());
        assert!(!info.architecture.is_empty());
        assert_eq!(info.edition_label, Edition::current().label());
    }
}
