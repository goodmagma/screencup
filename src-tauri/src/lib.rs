//! Screencup desktop app: lives in the tray, opens the capture gallery on click and runs
//! region captures through the native `screencup-overlay` binary.

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// Hotkeys that start a region capture. PrintScreen may be taken by the OS (Windows 11
/// routes it to Snipping Tool by default), so a combination is registered as well.
const CAPTURE_SHORTCUTS: [&str; 2] = ["PrintScreen", "CommandOrControl+Shift+X"];

/// Set while an overlay process is running, so repeated hotkeys do not stack overlays.
static CAPTURING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
struct Capture {
    path: PathBuf,
    name: String,
    modified_ms: u64,
}

/// Folder holding every capture: `<Pictures>/Screencup`.
fn library_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().picture_dir().map(|d| d.join("Screencup")).map_err(|e| e.to_string())
}

/// The overlay ships next to the app executable: in `target/<profile>` during development,
/// and as a bundled sidecar in installed builds.
fn overlay_exe() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("app executable has no parent directory")?;
    Ok(dir.join(format!("screencup-overlay{}", std::env::consts::EXE_SUFFIX)))
}

fn show_gallery(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn list_captures(app: AppHandle) -> Result<Vec<Capture>, String> {
    let dir = library_dir(&app)?;
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut captures: Vec<Capture> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("png")))
        .map(|e| {
            let modified_ms = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as u64);
            Capture { name: e.file_name().to_string_lossy().into_owned(), path: e.path(), modified_ms }
        })
        .collect();
    captures.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(captures)
}

/// Runs the overlay on a background thread; on success the new file is announced to the
/// gallery with a `capture-added` event and the gallery is brought to front.
#[tauri::command]
fn capture_region(app: AppHandle) {
    if CAPTURING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        if let Err(e) = run_overlay(&app) {
            eprintln!("capture failed: {e}");
        }
        CAPTURING.store(false, Ordering::SeqCst);
    });
}

fn run_overlay(app: &AppHandle) -> Result<(), String> {
    let name = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S%.3f.png").to_string();
    let out = library_dir(app)?.join(name);
    let exe = overlay_exe()?;
    let output = Command::new(&exe)
        .arg("--out")
        .arg(&out)
        .output()
        .map_err(|e| format!("{}: {e}", exe.display()))?;
    match output.status.code() {
        Some(0) => {
            app.emit("capture-added", &out).map_err(|e| e.to_string())?;
            show_gallery(app);
            Ok(())
        }
        Some(1) => Ok(()), // cancelled by the user
        _ => Err(String::from_utf8_lossy(&output.stderr).into_owned()),
    }
}

pub fn run() {
    tauri::Builder::default()
        // Must be registered first: a second launch only focuses the running instance.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_gallery(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        capture_region(app.clone());
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![list_captures, capture_region])
        .setup(|app| {
            // Tray-only app on macOS: no Dock icon, no app menu bar.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            for shortcut in CAPTURE_SHORTCUTS {
                if let Err(e) = app.global_shortcut().register(shortcut) {
                    eprintln!("cannot register {shortcut}: {e}");
                }
            }

            let menu = Menu::with_items(
                app,
                &[
                    &MenuItem::with_id(app, "capture", "Capture region", true, None::<&str>)?,
                    &MenuItem::with_id(app, "gallery", "Open gallery", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "quit", "Quit Screencup", true, None::<&str>)?,
                ],
            )?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().ok_or("missing app icon")?)
                .tooltip("Screencup")
                .menu(&menu)
                // Left click opens the gallery; the menu stays on right click. Linux tray
                // implementations report no clicks, so there the menu is the only entry point.
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "capture" => capture_region(app.clone()),
                    "gallery" => show_gallery(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_gallery(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        // Closing the gallery only hides it; the app keeps running in the tray.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Screencup");
}
