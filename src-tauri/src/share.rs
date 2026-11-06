//! Sharing: uploads a capture to an anonymous file host and hands back a public link.
//!
//! - Litterbox (litterbox.catbox.moe): temporary links, expiring after 1, 12, 24 or 72 hours.
//! - Catbox (catbox.moe): permanent links. Anonymous uploads cannot be deleted later.
//!
//! Neither needs an account or an API key. Every link is kept in `shares.json` in the app
//! data folder so the gallery can copy it again.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::library;

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Service {
    Litterbox,
    Catbox,
}

impl Service {
    fn endpoint(self) -> &'static str {
        match self {
            Service::Litterbox => "https://litterbox.catbox.moe/resources/internals/api.php",
            Service::Catbox => "https://catbox.moe/user/api.php",
        }
    }

    /// Largest file each host accepts.
    fn max_bytes(self) -> u64 {
        match self {
            Service::Litterbox => 1_000_000_000,
            Service::Catbox => 200_000_000,
        }
    }
}

/// Lifetimes Litterbox offers, in hours. Must match `SHARE_EXPIRIES` in src/Settings.tsx.
pub const EXPIRY_HOURS: [u32; 4] = [1, 12, 24, 72];

#[derive(Clone, Serialize, Deserialize)]
pub struct Share {
    pub name: String,
    pub url: String,
    pub service: Service,
    pub uploaded_ms: u64,
    /// `None` for permanent links.
    pub expires_ms: Option<u64>,
}

const TIMEOUT: Duration = Duration::from_secs(600);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn store<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path().app_data_dir().map(|d| d.join("shares.json")).map_err(|e| e.to_string())
}

fn load<R: Runtime>(app: &AppHandle<R>) -> Vec<Share> {
    store(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save<R: Runtime>(app: &AppHandle<R>, shares: &[Share]) -> Result<(), String> {
    let path = store(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let json = serde_json::to_string_pretty(shares).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("{}: {e}", path.display()))
}

/// Uploads one capture and records the link. Expiry for Litterbox comes from the settings.
#[tauri::command]
pub async fn share_capture(app: AppHandle, name: String, service: Service) -> Result<Share, String> {
    let path = library::resolve(&app, &name)?;
    let size = std::fs::metadata(&path).map_err(|e| format!("{}: {e}", path.display()))?.len();
    if size > service.max_bytes() {
        return Err(format!("{name}: {} MB > {} MB", size / 1_000_000, service.max_bytes() / 1_000_000));
    }
    let hours = match crate::settings::load(&app).share_expiry_hours {
        h if EXPIRY_HOURS.contains(&h) => h,
        _ => 24,
    };

    let mut form = reqwest::multipart::Form::new()
        .text("reqtype", "fileupload")
        .file("fileToUpload", &path)
        .await
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if service == Service::Litterbox {
        form = form.text("time", format!("{hours}h"));
    }
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(concat!("Screencup/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client.post(service.endpoint()).multipart(form).send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    let url = body.trim();
    // Both hosts answer with the bare link on success, with an error text otherwise.
    if !status.is_success() || !url.starts_with("https://") {
        return Err(format!("{status}: {}", url.chars().take(200).collect::<String>()));
    }

    let uploaded_ms = now_ms();
    let share = Share {
        name,
        url: url.to_string(),
        service,
        uploaded_ms,
        expires_ms: (service == Service::Litterbox).then(|| uploaded_ms + u64::from(hours) * 3_600_000),
    };
    let mut shares = load(&app);
    shares.push(share.clone());
    save(&app, &shares)?;
    Ok(share)
}

/// Links still valid, newest first; expired ones are dropped from the store.
#[tauri::command]
pub fn list_shares(app: AppHandle) -> Vec<Share> {
    let now = now_ms();
    let all = load(&app);
    let mut live: Vec<Share> = all.iter().filter(|s| s.expires_ms.is_none_or(|e| e > now)).cloned().collect();
    if live.len() != all.len() {
        let _ = save(&app, &live);
    }
    live.sort_by_key(|s| std::cmp::Reverse(s.uploaded_ms));
    live
}

/// Puts text (the links) on the clipboard.
#[tauri::command]
pub fn copy_text(app: AppHandle, text: String) -> Result<(), String> {
    crate::clipboard::copy_text(&app, &text)
}
