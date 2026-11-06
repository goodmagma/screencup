//! Screencup desktop app: lives in the tray, opens the capture gallery on click and runs
//! captures from the tray menu, global hotkeys or the gallery toolbar.

mod about;
mod audio;
mod capture;
mod clickfx;
mod clipboard;
mod edits;
mod hotkeys;
mod i18n;
mod library;
mod recorder;
mod settings;

use capture::CaptureKind;
use recorder::RecordKind;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::ShortcutState;

/// Gap between the gallery and the screen corner, in logical pixels.
const GALLERY_MARGIN: f64 = 8.0;

/// Shows the gallery anchored to the bottom-right corner of the work area (above the
/// taskbar) of the monitor under the cursor, which is where the tray icon was clicked.
pub(crate) fn show_gallery(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    let _ = w.unminimize();
    anchor_bottom_right(app, &w);
    let _ = w.show();
    // Moving to a monitor with another DPI rescales the window, so anchor again.
    anchor_bottom_right(app, &w);
    let _ = w.set_focus();
}

fn anchor_bottom_right(app: &AppHandle, w: &tauri::WebviewWindow) {
    let Ok(cursor) = app.cursor_position() else { return };
    let Ok(Some(monitor)) = app.monitor_from_point(cursor.x, cursor.y) else { return };
    let Ok(size) = w.outer_size() else { return };
    let area = monitor.work_area();
    let margin = (GALLERY_MARGIN * monitor.scale_factor()) as i32;
    let x = area.position.x + area.size.width as i32 - size.width as i32 - margin;
    let y = area.position.y + area.size.height as i32 - size.height as i32 - margin;
    let _ = w.set_position(PhysicalPosition::new(x.max(area.position.x), y.max(area.position.y)));
}

/// Opens the editor for a capture in its own window, or focuses it when already open.
/// Async on purpose: building a window from a synchronous command deadlocks on Windows.
/// Simplified high-contrast icon (tray-icon.svg) for the tray and window title/taskbar
/// icons. The default window icon is the largest layer of icon.ico, which turns muddy
/// when Windows scales it down to taskbar size.
pub fn small_icon() -> tauri::image::Image<'static> {
    tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png")).expect("valid tray.png")
}

/// The tray menu, in the current UI language.
fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let tr = |it, en| i18n::text(app, it, en);
    let item = |id: &str, label: &str| MenuItem::with_id(app, id, label, true, None::<&str>);
    Menu::with_items(
        app,
        &[
            &item("region", tr("Cattura una regione", "Capture a region"))?,
            &item("screen", tr("Cattura lo schermo", "Capture the screen"))?,
            &item("all", tr("Cattura tutti gli schermi", "Capture all screens"))?,
            &PredefinedMenuItem::separator(app)?,
            &item("rec-region", tr("Registra una regione", "Record a region"))?,
            &item("rec-screen", tr("Registra lo schermo", "Record the screen"))?,
            &item("rec-stop", tr("Ferma la registrazione", "Stop recording"))?,
            &PredefinedMenuItem::separator(app)?,
            &item("gallery", tr("Apri la galleria", "Open the gallery"))?,
            &item("settings", tr("Impostazioni...", "Settings..."))?,
            &item("about", tr("Informazioni su Screencup", "About Screencup"))?,
            &PredefinedMenuItem::separator(app)?,
            &item("quit", tr("Esci da Screencup", "Quit Screencup"))?,
        ],
    )
}

/// Rebuilds the tray menu after the UI language changed.
pub fn refresh_tray_menu(app: &AppHandle) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id("main"), tray_menu(app)) {
        let _ = tray.set_menu(Some(menu));
    }
}

#[tauri::command]
async fn open_editor(app: AppHandle, name: String) -> Result<(), String> {
    let label: String = format!("edit-{name}")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
        .collect();
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.unminimize();
        return w.set_focus().map_err(|e| e.to_string());
    }
    // The page reads the capture name from this global; see src/App.tsx.
    let init =
        format!("window.__SCREENCUP_EDIT__ = {};", serde_json::to_string(&name).map_err(|e| e.to_string())?);
    WebviewWindowBuilder::new(&app, label, WebviewUrl::App("index.html".into()))
        .initialization_script(&init)
        .title(format!("Screencup editor - {name}"))
        .icon(small_icon())
        .map_err(|e| e.to_string())?
        .inner_size(1280.0, 820.0)
        .min_inner_size(800.0, 500.0)
        .center()
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        // Must be registered first: a second launch only focuses the running instance.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_gallery(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        hotkeys::trigger(app, shortcut);
                    }
                })
                .build(),
        )
        .register_asynchronous_uri_scheme_protocol("thumb", library::thumbnail_protocol)
        .manage(clipboard::Clipboard::default())
        .manage(recorder::Recorder::default())
        .manage(hotkeys::Bindings::default())
        .plugin(tauri_plugin_dialog::init())
        // Launched at login with --autostart; the app starts hidden in the tray either way.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .invoke_handler(tauri::generate_handler![
            capture::capture,
            i18n::get_language,
            about::about_info,
            about::open_about,
            about::open_licenses,
            about::open_repository,
            open_editor,
            recorder::toggle_recording,
            recorder::stop_recording,
            recorder::cancel_recording,
            recorder::start_prepared,
            recorder::reselect_region,
            settings::get_settings,
            settings::set_settings,
            settings::default_library_dir,
            settings::pick_library_dir,
            settings::get_autostart,
            settings::set_autostart,
            settings::suspend_hotkeys,
            settings::open_settings,
            settings::open_library_dir,
            library::open_capture,
            library::reveal_capture,
            clipboard::copy_capture,
            library::list_captures,
            library::delete_captures,
            library::drag_captures,
            edits::read_edit_source,
            edits::load_annotations,
            edits::save_annotations,
            edits::save_edit_image,
        ])
        .setup(|app| {
            if let Some(main) = app.get_webview_window("main") {
                main.set_icon(small_icon())?;
            }
            library::enforce_limit_async(app.handle());
            // Tray-only app on macOS: no Dock icon, no app menu bar.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            hotkeys::apply(app.handle(), &settings::load(app.handle()).hotkeys);

            TrayIconBuilder::with_id("main")
                .icon(small_icon())
                .tooltip("Screencup")
                .menu(&tray_menu(app.handle())?)
                // Left click opens the gallery; the menu stays on right click. Linux tray
                // implementations report no clicks, so there the menu is the only entry point.
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "region" => capture::capture(app.clone(), CaptureKind::Region),
                    "screen" => capture::capture(app.clone(), CaptureKind::Screen),
                    "all" => capture::capture(app.clone(), CaptureKind::All),
                    "rec-region" => recorder::toggle(app.clone(), RecordKind::Region),
                    "rec-screen" => recorder::toggle(app.clone(), RecordKind::Screen),
                    "rec-stop" => recorder::stop(app.clone()),
                    "gallery" => show_gallery(app),
                    "settings" => {
                        if let Err(e) = settings::show(app) {
                            eprintln!("settings window: {e}");
                        }
                    }
                    "about" => {
                        if let Err(e) = about::show(app) {
                            eprintln!("about window: {e}");
                        }
                    }
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
        // Closing the gallery only hides it; the app keeps running in the tray. Editor
        // windows close normally.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event
                && window.label() == "main"
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Screencup");
}
