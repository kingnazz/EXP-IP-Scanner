// Prevents an extra console window on Windows in release. This is a GUI app;
// the child processes it spawns are separately suppressed with CREATE_NO_WINDOW
// where they should be invisible, and deliberately not where they should not.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    exp_ip_scanner_lib::run()
}
