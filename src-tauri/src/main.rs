// Release builds on Windows are GUI apps: no console window behind the tray icon.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    screencup_lib::run()
}
