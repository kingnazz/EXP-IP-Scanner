//! Build script.
//!
//! The one thing it does beyond the default is choose which capability set the
//! window gets, because the two editions do not link the same plugins. A
//! portable build has no `tauri-plugin-updater` and no `tauri-plugin-process`,
//! so a capability file naming `updater:default` would not merely be redundant
//! there -- it would fail the build, which is a fair description of what it
//! should do.
//!
//! Two directories rather than one file with conditional entries, so the
//! permissions granted to each edition stay readable as a list. That is the
//! whole point of a capability file.

fn main() {
    let portable = std::env::var_os("CARGO_FEATURE_PORTABLE").is_some();
    let pattern = if portable {
        "./capabilities/portable/*"
    } else {
        "./capabilities/installed/*"
    };

    // tauri-build emits no rerun-if-changed for a custom capabilities path.
    println!("cargo:rerun-if-changed=capabilities");

    tauri_build::try_build(tauri_build::Attributes::new().capabilities_path_pattern(pattern))
        .expect("failed to run tauri-build");
}
