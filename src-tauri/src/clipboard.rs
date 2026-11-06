//! Image clipboard. One `arboard::Clipboard` lives for the whole app: on X11 the clipboard
//! content is served by its owner, so dropping it right after a copy would lose the image.

use std::borrow::Cow;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime};
use xcap::image::RgbaImage;

use crate::library;

#[derive(Default)]
pub struct Clipboard(Mutex<Option<arboard::Clipboard>>);

pub fn copy_image<R: Runtime>(app: &AppHandle<R>, img: &RgbaImage) -> Result<(), String> {
    let state = app.state::<Clipboard>();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        *guard = Some(arboard::Clipboard::new().map_err(|e| e.to_string())?);
    }
    let clipboard = guard.as_mut().expect("clipboard initialised above");
    clipboard
        .set_image(arboard::ImageData {
            width: img.width() as usize,
            height: img.height() as usize,
            bytes: Cow::Borrowed(img.as_raw()),
        })
        .map_err(|e| e.to_string())
}

pub fn copy_text<R: Runtime>(app: &AppHandle<R>, text: &str) -> Result<(), String> {
    let state = app.state::<Clipboard>();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        *guard = Some(arboard::Clipboard::new().map_err(|e| e.to_string())?);
    }
    guard.as_mut().expect("clipboard initialised above").set_text(text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn copy_capture(app: AppHandle, name: String) -> Result<(), String> {
    if library::is_video(std::path::Path::new(&name)) {
        return Err("I video non si possono ancora copiare negli appunti".into());
    }
    copy_image(&app, &library::load(&app, &name)?)
}

/// Ctrl+V in the gallery: files copied in the file manager are imported like a drop; an
/// image (copied from a browser, an editor, a screenshot tool) becomes a new capture.
/// Returns the new captures; empty when the clipboard holds neither.
#[tauri::command]
pub async fn paste_capture(app: AppHandle) -> Result<Vec<std::path::PathBuf>, String> {
    let handle = app.clone();
    let (imported, errors) = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        let state = handle.state::<Clipboard>();
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        if guard.is_none() {
            *guard = Some(arboard::Clipboard::new().map_err(|e| e.to_string())?);
        }
        let clipboard = guard.as_mut().expect("clipboard initialised above");
        if let Ok(files) = clipboard.get().file_list()
            && !files.is_empty()
        {
            drop(guard);
            return library::import_files(&handle, files);
        }
        match clipboard.get_image() {
            Ok(data) => {
                let img = RgbaImage::from_raw(data.width as u32, data.height as u32, data.bytes.into_owned())
                    .ok_or("clipboard image has an unexpected size")?;
                drop(guard);
                Ok((vec![library::save_new_capture(&handle, &img)?], Vec::new()))
            }
            Err(_) => Ok((Vec::new(), Vec::new())),
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    library::announce_imports(&app, imported, errors)
}
