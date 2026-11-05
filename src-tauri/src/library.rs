//! The capture library: PNG files in `<Pictures>/Screencup`, plus cached thumbnails in the
//! app cache directory served to the gallery through the `thumb:` URI scheme.

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use percent_encoding::percent_decode_str;
use serde::Serialize;
use tauri::http::{Request, Response, header::CONTENT_TYPE};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder};
use xcap::image::{ImageFormat, RgbaImage};

/// Longest side of a gallery thumbnail, in pixels (cards are ~200 CSS px, so 2x DPI fits).
const THUMB_SIZE: u32 = 480;

#[derive(Serialize)]
pub struct Capture {
    path: PathBuf,
    name: String,
    modified_ms: u64,
    video: bool,
}

/// File extensions the library lists: screenshots and screen recordings.
const IMAGE_EXT: &str = "png";
const VIDEO_EXT: &str = "mp4";

pub fn is_video(path: &Path) -> bool {
    path.extension().is_some_and(|x| x.eq_ignore_ascii_case(VIDEO_EXT))
}

/// `<Pictures>/Screencup`, used unless the settings name another folder.
pub fn default_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path().picture_dir().map(|d| d.join("Screencup")).map_err(|e| e.to_string())
}

pub fn dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    match crate::settings::load(app).library_dir {
        Some(custom) => Ok(custom),
        None => default_dir(app),
    }
}

/// Opens a capture with the OS default app (videos in the system player).
#[tauri::command]
pub fn open_capture(app: AppHandle, name: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = resolve(&app, &name)?;
    app.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

/// Shows a capture selected in the OS file manager.
#[tauri::command]
pub fn reveal_capture(app: AppHandle, name: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().reveal_item_in_dir(resolve(&app, &name)?).map_err(|e| e.to_string())
}

fn thumbs_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path().app_cache_dir().map(|d| d.join("thumbs")).map_err(|e| e.to_string())
}

/// A fresh, timestamped file path for a new capture.
pub fn new_capture_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let name = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S%.3f.png").to_string();
    Ok(dir(app)?.join(name))
}

pub fn save_png(img: &RgbaImage, path: &Path) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    img.save(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Maps a bare file name coming from the webview to a file in the library, rejecting
/// anything that could point outside it.
pub fn resolve<R: Runtime>(app: &AppHandle<R>, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.starts_with('.') || name.contains(['/', '\\', ':']) {
        return Err(format!("invalid capture name: {name}"));
    }
    Ok(dir(app)?.join(name))
}

fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

#[tauri::command]
pub fn list_captures(app: AppHandle) -> Result<Vec<Capture>, String> {
    let Ok(entries) = std::fs::read_dir(dir(&app)?) else {
        return Ok(Vec::new());
    };
    let mut captures: Vec<Capture> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter(|e| {
            e.path()
                .extension()
                .is_some_and(|x| x.eq_ignore_ascii_case(IMAGE_EXT) || x.eq_ignore_ascii_case(VIDEO_EXT))
        })
        .map(|e| {
            let modified_ms = modified(&e.path())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as u64);
            Capture {
                name: e.file_name().to_string_lossy().into_owned(),
                path: e.path(),
                modified_ms,
                video: is_video(&e.path()),
            }
        })
        .collect();
    captures.sort_by_key(|c| std::cmp::Reverse(c.modified_ms));
    Ok(captures)
}

/// Moves a capture, with its original and annotations if it was edited, to the OS trash
/// (recoverable) and drops its cached thumbnail.
#[tauri::command]
pub fn delete_capture(app: AppHandle, name: String) -> Result<(), String> {
    let originals = crate::edits::originals_dir(&app)?;
    let files: Vec<PathBuf> =
        [resolve(&app, &name)?, originals.join(&name), originals.join(format!("{name}.json"))]
            .into_iter()
            .filter(|p| p.exists())
            .collect();
    trash::delete_all(files).map_err(|e| e.to_string())?;
    if let Ok(thumbs) = thumbs_dir(&app) {
        let _ = std::fs::remove_file(thumbs.join(&name));
    }
    Ok(())
}

pub fn load<R: Runtime>(app: &AppHandle<R>, name: &str) -> Result<RgbaImage, String> {
    let path = resolve(app, name)?;
    xcap::image::open(&path).map(|i| i.into_rgba8()).map_err(|e| format!("{}: {e}", path.display()))
}

/// PNG bytes of the thumbnail for `name`, regenerated when older than the capture.
fn thumbnail<R: Runtime>(app: &AppHandle<R>, name: &str) -> Result<Vec<u8>, String> {
    let src = resolve(app, name)?;
    let thumb = thumbs_dir(app)?.join(name);
    if let (Some(t), Some(s)) = (modified(&thumb), modified(&src))
        && t >= s
        && let Ok(bytes) = std::fs::read(&thumb)
    {
        return Ok(bytes);
    }
    let bytes = if is_video(&src) {
        crate::recorder::video_frame(&src, THUMB_SIZE)?
    } else {
        let img = xcap::image::open(&src).map_err(|e| format!("{}: {e}", src.display()))?;
        let mut bytes = Vec::new();
        img.thumbnail(THUMB_SIZE, THUMB_SIZE)
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        bytes
    };
    // The cache is best effort: a failed write only means regenerating next time.
    if let Some(parent) = thumb.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&thumb, &bytes);
    Ok(bytes)
}

/// Handler for `thumb://localhost/<name>` (`http://thumb.localhost/<name>` on Windows).
/// Decoding and resizing run off the main thread.
pub fn thumbnail_protocol<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    let name =
        percent_decode_str(request.uri().path().trim_start_matches('/')).decode_utf8_lossy().into_owned();
    std::thread::spawn(move || {
        let response = match thumbnail(&app, &name) {
            Ok(bytes) => Response::builder().header(CONTENT_TYPE, "image/png").body(bytes),
            Err(e) => Response::builder().status(404).header(CONTENT_TYPE, "text/plain").body(e.into_bytes()),
        };
        responder.respond(response.expect("valid thumbnail response"));
    });
}
