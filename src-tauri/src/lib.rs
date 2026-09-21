mod backstage;
mod commands;
mod ipparse;
mod launch;
mod netinfo;
mod oui;
mod ports;
mod runtime;
mod scanner;

use tauri::{Manager, WebviewWindowBuilder};

// The portable edition exists partly in order *not* to contain the installer
// updater. Enabling both features would produce a binary that reports itself as
// portable while carrying an install-and-relaunch path, which is exactly what
// the release promises cannot happen -- so it is a build error rather than a
// runtime check.
#[cfg(all(feature = "portable", feature = "installed-updater"))]
compile_error!(
    "the `portable` and `installed-updater` features are mutually exclusive: build the portable \
     edition with --no-default-features --features portable"
);

/// Run the console companion used in ScreenConnect Backstage and other
/// limited Windows shells. It shares the same scanner as the desktop app and
/// deliberately initializes no Tauri window or WebView.
pub fn run_backstage() -> i32 {
    backstage::run()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());

    // The installed edition's auto-updater, plus the process plugin it needs to
    // relaunch after installing. Not compiled into a portable build at all: see
    // the feature documentation in Cargo.toml.
    #[cfg(all(desktop, feature = "installed-updater"))]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    builder
        .setup(|app| {
            // The window is built here rather than by Tauri's own config pass
            // (`app.windows[0].create` is false in tauri.conf.json) for one
            // reason: the portable edition has to name its WebView profile
            // directory, and that has to be set before the WebView is created.
            // There is no supported way to move it afterwards.
            //
            // `from_config` is the exact builder Tauri would have used, given
            // the exact same config, so the installed window is the window it
            // has always been.
            let config = app
                .config()
                .app
                .windows
                .first()
                .ok_or("tauri.conf.json declares no window")?
                .clone();
            let mut window = WebviewWindowBuilder::from_config(app.handle(), &config)?;

            if let Ok(local_data) = app.path().app_local_data_dir() {
                if let Some(profile) = runtime::webview_profile_dir(&local_data) {
                    // Created up front: WebView2 will not create a profile
                    // directory whose parent does not exist, and a portable
                    // copy is routinely the first thing to run on a machine.
                    std::fs::create_dir_all(&profile).map_err(|e| {
                        format!(
                            "EXP IP Scanner Portable could not create its settings folder at {}: {e}",
                            profile.display()
                        )
                    })?;
                    window = window.data_directory(profile);
                }
            }

            window.build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::runtime_info,
            commands::detect_networks,
            commands::service_catalog,
            commands::default_ports,
            commands::parse_port_spec,
            commands::preview_scan,
            commands::scan_network,
            commands::cancel_scan,
            commands::save_text,
            commands::open_web,
            commands::open_smb,
            commands::open_rdp,
            commands::open_ssh,
            commands::open_vnc,
            commands::open_ping_console,
            commands::open_traceroute_console,
            commands::ping_host,
            commands::open_site,
            commands::open_releases,
            commands::open_privacy,
        ])
        .build(tauri::generate_context!())
        .expect("error while building EXP IP Scanner")
        .run(|_app, event| {
            // Closing the window while a scan is running should not leave the
            // sweep going in a process that is on its way out.
            if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
                scanner::request_cancel();
            }
        });
}
