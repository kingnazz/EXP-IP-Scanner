// ScreenConnect Backstage uses a custom Windows shell where WebView-based
// applications are not dependable. Build this as a plain console executable
// from the same scanner modules as the desktop app, without initializing or
// linking through the Tauri application library.

#[path = "../backstage.rs"]
mod backstage;
#[path = "../ipparse.rs"]
mod ipparse;
#[path = "../netinfo.rs"]
mod netinfo;
#[path = "../oui.rs"]
mod oui;
#[path = "../ports.rs"]
mod ports;
#[path = "../scanner.rs"]
mod scanner;

fn main() {
    std::process::exit(backstage::run());
}
