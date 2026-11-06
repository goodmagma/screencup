//! The "About Screencup" window: version, project page, licences.

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

const LABEL: &str = "about";
/// From `repository` in the workspace Cargo.toml.
const REPOSITORY: &str = env!("CARGO_PKG_REPOSITORY");

#[derive(Serialize)]
pub struct AboutInfo {
    version: String,
    repository: &'static str,
}

#[tauri::command]
pub fn about_info(app: AppHandle) -> AboutInfo {
    AboutInfo { version: app.package_info().version.to_string(), repository: REPOSITORY }
}

/// Opens the project page in the default browser. The URL is fixed here, not taken from
/// the webview.
#[tauri::command]
pub fn open_repository(app: AppHandle) -> Result<(), String> {
    app.opener().open_url(REPOSITORY, None::<&str>).map_err(|e| e.to_string())
}

/// Opens the `licenses` folder installed next to the app (bundle.resources).
#[tauri::command]
pub fn open_licenses(app: AppHandle) -> Result<(), String> {
    let dir = app.path().resource_dir().map_err(|e| e.to_string())?.join("licenses");
    if !dir.is_dir() {
        let missing = crate::i18n::text(&app, "licenses-missing");
        return Err(format!("{}: {missing}", dir.display()));
    }
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

/// Async: building a window from a synchronous command deadlocks on Windows.
#[tauri::command]
pub async fn open_about(app: AppHandle) -> Result<(), String> {
    show(&app)
}

pub fn show(app: &AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.unminimize();
        return w.set_focus().map_err(|e| e.to_string());
    }
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .initialization_script("window.__SCREENCUP_ABOUT__ = true;")
        .title(crate::i18n::text(app, "about"))
        .icon(crate::small_icon())
        .map_err(|e| e.to_string())?
        .inner_size(420.0, 400.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .center()
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
