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
                    Ok(Some(info)) => mark_available(&app, &info),
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

/// Tells the gallery (`update-available`) and puts a blue dot on the tray icon, with the new
/// version in its tooltip. Nothing resets it: installing restarts the app.
fn mark_available(app: &AppHandle, info: &UpdateInfo) {
    let _ = app.emit("update-available", info);
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_icon(Some(badged_icon()));
        let tip = crate::i18n::text(app, "update-tooltip").replace("{version}", &info.version);
        let _ = tray.set_tooltip(Some(format!("Screencup - {tip}")));
    }
}

/// The tray icon with a blue dot in the bottom-right corner, ringed in white so it stands out
/// on dark and light taskbars alike.
fn badged_icon() -> tauri::image::Image<'static> {
    let icon = crate::small_icon();
    let (w, h) = (icon.width(), icon.height());
    let mut rgba = icon.rgba().to_vec();
    let size = w.min(h) as f32;
    let r = size * 0.24;
    let ring = size * 0.06;
    let (cx, cy) = (w as f32 - r - ring, h as f32 - r - ring);
    for y in 0..h {
        for x in 0..w {
            let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
            // Antialiased edges: coverage over the last pixel of each circle.
            let dot = (r - d + 0.5).clamp(0.0, 1.0);
            let outer = (r + ring - d + 0.5).clamp(0.0, 1.0);
            if outer <= 0.0 {
                continue;
            }
            let i = ((y * w + x) * 4) as usize;
            let px = &mut rgba[i..i + 4];
            // White ring under the blue dot, both blended over the icon.
            for (color, a) in [([255u8, 255, 255], outer), ([0x1E, 0x88, 0xE5], dot)] {
                if a <= 0.0 {
                    continue;
                }
                let base = px[3] as f32 / 255.0;
                let out_a = a + base * (1.0 - a);
                for c in 0..3 {
                    let v = (color[c] as f32 * a + px[c] as f32 * base * (1.0 - a)) / out_a;
                    px[c] = v.round() as u8;
                }
                px[3] = (out_a * 255.0).round() as u8;
            }
        }
    }
    tauri::image::Image::new_owned(rgba, w, h)
}

/// "Check for updates" in the About window: `None` when up to date.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let found = check(&app).await?;
    if let Some(info) = &found {
        mark_available(&app, info);
    }
    Ok(found)
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
