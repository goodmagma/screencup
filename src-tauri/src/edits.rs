//! Non-destructive editing. The first edit of a capture moves its pristine pixels to
//! `<library>/.originals/<name>`; the annotations live next to it as `<name>.json`, and the
//! library file itself becomes the flattened render. Reopening the editor starts from the
//! original plus the annotations, so every shape stays editable.

use std::path::PathBuf;

use percent_encoding::percent_decode_str;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Runtime};

use crate::library;

pub fn originals_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(library::dir(app)?.join(".originals"))
}

/// Path of the pristine copy, creating it from the current file on first use.
fn ensure_original<R: Runtime>(app: &AppHandle<R>, name: &str) -> Result<PathBuf, String> {
    let current = library::resolve(app, name)?;
    let dir = originals_dir(app)?;
    let original = dir.join(name);
    if !original.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        std::fs::copy(&current, &original).map_err(|e| format!("{}: {e}", original.display()))?;
    }
    Ok(original)
}

/// PNG bytes the editor starts from: the original when the capture was edited before.
#[tauri::command]
pub fn read_edit_source(app: AppHandle, name: String) -> Result<Response, String> {
    let original = originals_dir(&app)?.join(&name);
    let path = if original.exists() { original } else { library::resolve(&app, &name)? };
    std::fs::read(&path).map(Response::new).map_err(|e| format!("{}: {e}", path.display()))
}

#[tauri::command]
pub fn load_annotations(app: AppHandle, name: String) -> Result<Option<String>, String> {
    library::resolve(&app, &name)?;
    Ok(std::fs::read_to_string(originals_dir(&app)?.join(format!("{name}.json"))).ok())
}

#[tauri::command]
pub fn save_annotations(app: AppHandle, name: String, json: String) -> Result<(), String> {
    let original = ensure_original(&app, &name)?;
    let path = original.with_file_name(format!("{name}.json"));
    std::fs::write(&path, json).map_err(|e| format!("{}: {e}", path.display()))
}

/// Overwrites the library file with the flattened render. The PNG travels as the raw
/// request body (no base64); the capture name is the percent-encoded `x-name` header.
#[tauri::command]
pub fn save_edit_image(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(png) = request.body() else {
        return Err("expected raw PNG bytes".into());
    };
    let name = request
        .headers()
        .get("x-name")
        .and_then(|v| v.to_str().ok())
        .map(|v| percent_decode_str(v).decode_utf8_lossy().into_owned())
        .ok_or("missing x-name header")?;
    ensure_original(&app, &name)?;
    let path = library::resolve(&app, &name)?;
    std::fs::write(&path, png).map_err(|e| format!("{}: {e}", path.display()))?;
    let _ = app.emit("capture-updated", &name);
    Ok(())
}
