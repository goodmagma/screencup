//! Screencup desktop app: lives in the tray, opens the capture gallery on click and runs
//! captures from the tray menu, global hotkeys or the gallery toolbar.

mod capture;
mod clipboard;
mod edits;
mod library;

use capture::CaptureKind;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, ShortcutState};

/// Global hotkeys. PrintScreen may be taken by the OS (Windows 11 can route it to Snipping
/// Tool) or another capture tool, so a combination is registered for regions as well.
const SHORTCUTS: [&str; 3] = ["PrintScreen", "CommandOrControl+Shift+X", "Shift+PrintScreen"];

pub(crate) fn show_gallery(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn run() {
    tauri::Builder::default()
        // Must be registered first: a second launch only focuses the running instance.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_gallery(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    let kind = if shortcut.matches(Modifiers::SHIFT, Code::PrintScreen) {
                        CaptureKind::Screen
                    } else {
                        CaptureKind::Region
                    };
                    capture::capture(app.clone(), kind);
                })
                .build(),
        )
        .register_asynchronous_uri_scheme_protocol("thumb", library::thumbnail_protocol)
        .manage(clipboard::Clipboard::default())
        .invoke_handler(tauri::generate_handler![
            capture::capture,
            clipboard::copy_capture,
            library::list_captures,
            library::delete_capture,
            edits::read_edit_source,
            edits::load_annotations,
            edits::save_annotations,
            edits::save_edit_image,
        ])
        .setup(|app| {
            // Tray-only app on macOS: no Dock icon, no app menu bar.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            for shortcut in SHORTCUTS {
                if let Err(e) = app.global_shortcut().register(shortcut) {
                    eprintln!("cannot register {shortcut}: {e}");
                }
            }

            let menu = Menu::with_items(
                app,
                &[
                    &MenuItem::with_id(app, "region", "Capture region", true, None::<&str>)?,
                    &MenuItem::with_id(app, "screen", "Capture screen", true, None::<&str>)?,
                    &MenuItem::with_id(app, "all", "Capture all screens", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
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
                    "region" => capture::capture(app.clone(), CaptureKind::Region),
                    "screen" => capture::capture(app.clone(), CaptureKind::Screen),
                    "all" => capture::capture(app.clone(), CaptureKind::All),
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
