//! Automatic updates from GitHub Releases (tauri-plugin-updater). The release workflow
//! publishes a signed installer and `latest.json`; the app checks it shortly after start and
//! then every few hours, and tells the gallery (`update-available`) when a newer version
//! exists. Installing is the user's choice: it downloads, runs the installer and restarts.

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// Delay before the first check, so it never slows down the start.
const FIRST_CHECK: Duration = Duration::from_secs(15);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 3600);

#[derive(Clone, Serialize)]
pub struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

/// Starts the periodic check, when enabled in the settings.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio_sleep(FIRST_CHECK).await;
        loop {
            if crate::settings::load(&app).check_updates {
                match check(&app).await {
                    Ok(Some(info)) => {
                        let _ = app.emit("update-available", &info);
                    }
                    Ok(None) => {}
                    Err(e) => eprintln!("update check: {e}"),
                }
            }
            tokio_sleep(CHECK_EVERY).await;
        }
    });
}

async fn tokio_sleep(d: Duration) {
    // The async runtime is Tokio; a blocking thread keeps this module free of a direct
    // Tokio dependency.
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

async fn check(app: &AppHandle) -> Result<Option<UpdateInfo>, String> {
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| UpdateInfo { version: u.version, notes: u.body }))
}

/// "Check for updates" in the About window: `None` when up to date.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    check(&app).await
}

/// Downloads and runs the new installer, then restarts the app.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("no update available")?;
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    app.restart()
}
