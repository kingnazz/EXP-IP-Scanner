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

/// A separate WebView2 profile for ScreenConnect Backstage / Session 0 style
/// launches. Backstage commonly runs under SYSTEM or the Services session, and
/// keeping its browser data separate avoids both permission problems and
/// WebView2 option conflicts with an ordinary interactive launch.
pub const BACKSTAGE_PROFILE_DIR: &str = "backstage-webview";

/// Browser flags used only for Backstage-compatible launches.
///
/// ScreenConnect Backstage uses a custom shell where browser-style GPU /
/// DirectComposition surfaces are a known weak point. Tauri replaces WRY\'s
/// default browser arguments when additional_browser_args is used, so the
/// three WRY defaults are repeated here intentionally.
#[cfg(target_os = "windows")]
pub const BACKSTAGE_WEBVIEW_ARGS: &str =
    "--disable-gpu-compositing --disable-direct-composition \\\n     --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

fn truthy(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn looks_like_backstage(username: &str, session_name: &str) -> bool {
    username.eq_ignore_ascii_case("SYSTEM") || session_name.eq_ignore_ascii_case("Services")
}

/// Whether this process should use the Backstage-safe WebView2 path.
///
/// ScreenConnect Backstage normally presents a SYSTEM / Services-style
/// environment. The explicit command-line and environment overrides are
/// deliberate escape hatches for ScreenConnect builds that create a separate
/// logon session instead.
pub fn backstage_compatibility_requested() -> bool {
    if !cfg!(target_os = "windows") {
        return false;
    }

    if std::env::args_os()
        .skip(1)
        .any(|arg| arg.to_string_lossy().eq_ignore_ascii_case("--backstage"))
    {
        return true;
    }

    if std::env::var("EXP_IP_SCANNER_BACKSTAGE")
        .ok()
        .as_deref()
        .is_some_and(truthy)
    {
        return true;
    }

    let username = std::env::var("USERNAME").unwrap_or_default();
    let session_name = std::env::var("SESSIONNAME").unwrap_or_default();
    looks_like_backstage(&username, &session_name)
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
pub fn webview_profile_dir(local_data_dir: &Path, backstage_compat: bool) -> Option<PathBuf> {
    if backstage_compat {
        Some(local_data_dir.join(BACKSTAGE_PROFILE_DIR))
    } else {
        Edition::current()
            .is_portable()
            .then(|| local_data_dir.join(PORTABLE_PROFILE_DIR))
    }
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
            Edition::Installed => assert_eq!(webview_profile_dir(root, false), None),
            Edition::Portable => assert_eq!(
                webview_profile_dir(root, false),
                Some(root.join(PORTABLE_PROFILE_DIR))
            ),
        }
    }

    #[test]
    fn a_portable_profile_is_never_placed_beside_the_executable() {
        // The whole point: the extracted folder stays read-only-safe.
        let root = Path::new("/local/app/data");
        if let Some(profile) = webview_profile_dir(root, false) {
            assert!(
                profile.starts_with(root),
                "{profile:?} escaped the data root"
            );
        }
    }

    #[test]
    fn backstage_environment_detection_catches_screenconnect_style_launches() {
        assert!(looks_like_backstage("SYSTEM", "Services"));
        assert!(looks_like_backstage("SYSTEM", "Console"));
        assert!(looks_like_backstage("consultant", "Services"));
        assert!(!looks_like_backstage("consultant", "Console"));
    }

    #[test]
    fn backstage_uses_an_isolated_webview_profile() {
        let root = Path::new("/local/app/data");
        assert_eq!(
            webview_profile_dir(root, true),
            Some(root.join(BACKSTAGE_PROFILE_DIR))
        );
    }

    #[test]
    fn truthy_backstage_override_values_are_deliberately_narrow() {
        for value in ["1", "true", "TRUE", "yes", "on"] {
            assert!(truthy(value), "{value}");
        }
        for value in ["", "0", "false", "no", "anything"] {
            assert!(!truthy(value), "{value}");
        }
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
