//! The capture library: PNG files in `<Pictures>/Screencup`, plus cached thumbnails in the
//! app cache directory served to the gallery through the `thumb:` URI scheme.

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use percent_encoding::percent_decode_str;
use serde::Serialize;
use tauri::http::{Request, Response, header::CONTENT_TYPE};
use tauri::{AppHandle, Emitter, Manager, Runtime, UriSchemeContext, UriSchemeResponder};
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

/// Library files the gallery lists (screenshots and recordings), as (name, path).
fn capture_entries(dir: &Path) -> impl Iterator<Item = (String, PathBuf)> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
        .filter(|(_, p)| {
            p.extension()
                .is_some_and(|x| x.eq_ignore_ascii_case(IMAGE_EXT) || x.eq_ignore_ascii_case(VIDEO_EXT))
        })
}

#[tauri::command]
pub fn list_captures(app: AppHandle) -> Result<Vec<Capture>, String> {
    let mut captures: Vec<Capture> = capture_entries(&dir(&app)?)
        .map(|(name, path)| {
            let modified_ms = modified(&path)
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as u64);
            Capture { name, video: is_video(&path), path, modified_ms }
        })
        .collect();
    captures.sort_by_key(|c| std::cmp::Reverse(c.modified_ms));
    Ok(captures)
}

/// Moves captures, with their originals and annotations if they were edited, to the OS
/// trash (recoverable) in one operation, and drops their cached thumbnails.
#[tauri::command]
pub fn delete_captures(app: AppHandle, names: Vec<String>) -> Result<(), String> {
    trash_captures(&app, &names)
}

fn trash_captures<R: Runtime>(app: &AppHandle<R>, names: &[String]) -> Result<(), String> {
    let originals = crate::edits::originals_dir(app)?;
    let mut files = Vec::new();
    for name in names {
        files.extend(
            [resolve(app, name)?, originals.join(name), originals.join(format!("{name}.json"))]
                .into_iter()
                .filter(|p| p.exists()),
        );
    }
    if files.is_empty() {
        return Ok(());
    }
    trash::delete_all(files).map_err(|e| e.to_string())?;
    if let Ok(thumbs) = thumbs_dir(app) {
        for name in names {
            let _ = std::fs::remove_file(thumbs.join(name));
        }
    }
    Ok(())
}

/// Keeps at most `max_captures` (from the settings; 0 = no limit) captures in the library by
/// moving the oldest to the trash. Age is the capture time in the timestamped file name,
/// not the modification time, which editing bumps. Returns how many were removed.
pub fn enforce_limit<R: Runtime>(app: &AppHandle<R>) -> Result<usize, String> {
    let max = crate::settings::load(app).max_captures as usize;
    if max == 0 {
        return Ok(0);
    }
    let mut names: Vec<String> = capture_entries(&dir(app)?).map(|(name, _)| name).collect();
    if names.len() <= max {
        return Ok(0);
    }
    names.sort_unstable_by(|a, b| b.cmp(a));
    let old = names.split_off(max);
    trash_captures(app, &old)?;
    Ok(old.len())
}

/// Runs `enforce_limit` off the calling thread (trashing can be slow) and tells the gallery
/// to refresh when something was removed.
pub fn enforce_limit_async<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    std::thread::spawn(move || match enforce_limit(&app) {
        Ok(0) => {}
        Ok(_) => {
            let _ = app.emit("capture-updated", ());
        }
        Err(e) => eprintln!("capture limit: {e}"),
    });
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

/// Longest side of the picture under the cursor while dragging captures out, in pixels.
const DRAG_PREVIEW_SIZE: u32 = 160;

/// Drags captures out of the gallery as files, to drop them into other apps (an image
/// editor, a chat, Explorer). It is a native OS drag (OLE on Windows): the webview's own
/// drag and drop only works inside the page. Files are offered as a copy, the library keeps
/// them. Async, because the drag runs a modal loop on the main thread.
#[tauri::command]
pub async fn drag_captures(window: tauri::WebviewWindow, names: Vec<String>) -> Result<(), String> {
    let app = window.app_handle().clone();
    let paths = names.iter().map(|n| resolve(&app, n)).collect::<Result<Vec<_>, _>>()?;
    let preview = names.first().and_then(|n| drag_preview(&app, n)).unwrap_or_default();
    let (done, wait) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let result = drag::start_drag(
            &window,
            drag::DragItem::Files(paths),
            drag::Image::Raw(preview),
            |_, _| {},
            drag::Options { skip_animatation_on_cancel_or_failure: false, mode: drag::DragMode::Copy },
        );
        let _ = done.send(result.map_err(|e| e.to_string()));
    })
    .map_err(|e| e.to_string())?;
    wait.recv().map_err(|e| e.to_string())?
}

/// Small PNG of the capture's thumbnail for the drag cursor.
fn drag_preview<R: Runtime>(app: &AppHandle<R>, name: &str) -> Option<Vec<u8>> {
    let thumb = xcap::image::load_from_memory(&thumbnail(app, name).ok()?).ok()?;
    let small = thumb.thumbnail(DRAG_PREVIEW_SIZE, DRAG_PREVIEW_SIZE);
    let mut png = Vec::new();
    small.write_to(&mut Cursor::new(&mut png), ImageFormat::Png).ok()?;
    Some(png)
}
