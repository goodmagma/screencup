//! User preferences, stored as JSON in the app config directory.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

#[derive(Clone, Copy, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Record the default microphone into screen recordings.
    pub record_microphone: bool,
    /// Record what the computer plays (system output loopback) into screen recordings.
    pub record_system_audio: bool,
}

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

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Settings {
    load(&app)
}

#[tauri::command]
pub fn set_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let path = path(&app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("{}: {e}", path.display()))
}
