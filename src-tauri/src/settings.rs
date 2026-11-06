//! User preferences, stored as JSON in the app config directory, plus the commands of the
//! settings window. Start-at-login is not stored here: the OS registration is the truth.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_dialog::DialogExt as _;

use crate::hotkeys;

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Settings {
    /// Library folder; `None` means `<Pictures>/Screencup`.
    pub library_dir: Option<PathBuf>,
    /// Copy every new screenshot to the clipboard.
    pub copy_after_capture: bool,
    /// Bring the gallery up after a capture or recording.
    pub show_gallery_after_capture: bool,
    /// Record the default microphone into screen recordings.
    pub record_microphone: bool,
    /// Record what the computer plays (system output loopback) into screen recordings.
    pub record_system_audio: bool,
    /// Draw a ripple where the mouse is clicked in screen recordings.
    pub show_clicks: bool,
    pub framerate: u32,
    pub hotkeys: Hotkeys,
    /// Keep at most this many captures; older ones go to the trash. 0 = no limit.
    pub max_captures: u32,
}

/// Global shortcuts as accelerator strings (e.g. `Control+Shift+PrintScreen`); empty = none.
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Hotkeys {
    pub capture_region: String,
    pub capture_screen: String,
    pub capture_all: String,
    pub record_region: String,
    pub record_screen: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            library_dir: None,
            copy_after_capture: true,
            show_gallery_after_capture: true,
            record_microphone: false,
            record_system_audio: false,
            show_clicks: true,
            framerate: 30,
            hotkeys: Hotkeys::default(),
            max_captures: 0,
        }
    }
}

impl Default for Hotkeys {
    fn default() -> Self {
        Hotkeys {
            capture_region: "PrintScreen".into(),
            capture_screen: "Shift+PrintScreen".into(),
            capture_all: String::new(),
            record_region: "Control+PrintScreen".into(),
            record_screen: "Control+Shift+PrintScreen".into(),
        }
    }
}

pub const FRAMERATES: [u32; 3] = [15, 30, 60];

fn path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path().app_config_dir().map(|d| d.join("settings.json")).map_err(|e| e.to_string())
}

/// Missing or unreadable settings fall back to the defaults.
pub fn load<R: Runtime>(app: &AppHandle<R>) -> Settings {
    path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save<R: Runtime>(app: &AppHandle<R>, settings: &Settings) -> Result<(), String> {
    let path = path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("{}: {e}", path.display()))
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Settings {
    load(&app)
}

/// Saves the settings and re-registers the hotkeys (always: this also resumes them after
/// `suspend_hotkeys`). Returns one message per hotkey that could not be registered,
/// typically because another app owns it.
#[tauri::command]
pub fn set_settings(app: AppHandle, mut settings: Settings) -> Result<Vec<String>, String> {
    if !FRAMERATES.contains(&settings.framerate) {
        settings.framerate = Settings::default().framerate;
    }
    save(&app, &settings)?;
    crate::library::enforce_limit_async(&app);
    // Gallery and settings window both edit settings; each refreshes on this event.
    let _ = app.emit("settings-changed", &settings);
    Ok(hotkeys::apply(&app, &settings.hotkeys))
}

/// Default library folder, shown in the settings next to a custom choice.
#[tauri::command]
pub fn default_library_dir(app: AppHandle) -> Result<PathBuf, String> {
    crate::library::default_dir(&app)
}

/// Opens the current library folder in the OS file manager, creating it if needed.
#[tauri::command]
pub fn open_library_dir(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = crate::library::dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

/// Native folder picker for the library location; `None` when dismissed.
#[tauri::command]
pub async fn pick_library_dir(app: AppHandle) -> Option<PathBuf> {
    app.dialog().file().set_title("Cartella delle catture").blocking_pick_folder()?.into_path().ok()
}

#[tauri::command]
pub fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let launcher = app.autolaunch();
    if enabled { launcher.enable() } else { launcher.disable() }.map_err(|e| e.to_string())
}

/// While the settings window records a new shortcut, the global ones must not fire.
#[tauri::command]
pub fn suspend_hotkeys(app: AppHandle, suspended: bool) -> Vec<String> {
    if suspended {
        hotkeys::clear(&app);
        vec![]
    } else {
        hotkeys::apply(&app, &load(&app).hotkeys)
    }
}

/// Opens the settings window, or focuses it. Async: building a window from a synchronous
/// command deadlocks on Windows.
#[tauri::command]
pub async fn open_settings(app: AppHandle) -> Result<(), String> {
    show(&app)
}

pub fn show(app: &AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.unminimize();
        return w.set_focus().map_err(|e| e.to_string());
    }
    WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html".into()))
        .initialization_script("window.__SCREENCUP_SETTINGS__ = true;")
        .title("Impostazioni di Screencup")
        .icon(crate::small_icon())
        .map_err(|e| e.to_string())?
        .inner_size(640.0, 640.0)
        .min_inner_size(520.0, 420.0)
        .center()
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
