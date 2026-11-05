//! Capture flows. Region capture runs the native `screencup-overlay` binary; screen captures
//! are taken in-process. Every successful capture is saved to the library, copied to the
//! clipboard and announced to the gallery with a `capture-added` event.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use xcap::image::{RgbaImage, imageops};

use crate::{clipboard, library, show_gallery};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureKind {
    /// User-selected region on the frozen screen.
    Region,
    /// The monitor under the mouse cursor.
    Screen,
    /// Every monitor, stitched over the virtual desktop.
    All,
}

/// Set while a capture runs, so repeated hotkeys do not stack overlays.
static CAPTURING: AtomicBool = AtomicBool::new(false);

/// Time for the window manager to finish hiding the gallery before the screen is grabbed.
const HIDE_DELAY: Duration = Duration::from_millis(250);

#[tauri::command]
pub fn capture(app: AppHandle, kind: CaptureKind) {
    if CAPTURING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        // The gallery must not end up in its own screenshot.
        let gallery_was_visible = hide_gallery(&app);
        match run(&app, kind) {
            Ok(Some(path)) => {
                if let Err(e) = clipboard_copy(&app, &path) {
                    eprintln!("copy to clipboard failed: {e}");
                }
                let _ = app.emit("capture-added", &path);
                show_gallery(&app);
            }
            Ok(None) if gallery_was_visible => show_gallery(&app),
            Ok(None) => {}
            Err(e) => {
                eprintln!("capture failed: {e}");
                if gallery_was_visible {
                    show_gallery(&app);
                }
            }
        }
        CAPTURING.store(false, Ordering::SeqCst);
    });
}

/// Returns the saved file, or `None` when the user cancelled.
fn run(app: &AppHandle, kind: CaptureKind) -> Result<Option<PathBuf>, String> {
    let out = library::new_capture_path(app)?;
    let img = match kind {
        CaptureKind::Region => return Ok(run_overlay(&out)?.then_some(out)),
        CaptureKind::Screen => capture_screen_under_cursor(app)?,
        CaptureKind::All => capture_all_screens()?,
    };
    library::save_png(&img, &out)?;
    Ok(Some(out))
}

fn hide_gallery(app: &AppHandle) -> bool {
    let Some(w) = app.get_webview_window("main") else { return false };
    if !w.is_visible().unwrap_or(false) || w.is_minimized().unwrap_or(false) {
        return false;
    }
    let _ = w.hide();
    std::thread::sleep(HIDE_DELAY);
    true
}

fn clipboard_copy(app: &AppHandle, path: &Path) -> Result<(), String> {
    let img = xcap::image::open(path).map_err(|e| e.to_string())?.into_rgba8();
    clipboard::copy_image(app, &img)
}

fn capture_screen_under_cursor(app: &AppHandle) -> Result<RgbaImage, String> {
    let p = app.cursor_position().map_err(|e| e.to_string())?;
    let monitor = xcap::Monitor::from_point(p.x as i32, p.y as i32).map_err(|e| e.to_string())?;
    monitor.capture_image().map_err(|e| e.to_string())
}

fn capture_all_screens() -> Result<RgbaImage, String> {
    let err = |e: xcap::XCapError| e.to_string();
    let shots = xcap::Monitor::all()
        .map_err(err)?
        .iter()
        .map(|m| Ok((m.x().map_err(err)?, m.y().map_err(err)?, m.capture_image().map_err(err)?)))
        .collect::<Result<Vec<_>, String>>()?;
    let left = shots.iter().map(|(x, _, _)| *x).min().ok_or("no monitors found")?;
    let top = shots.iter().map(|(_, y, _)| *y).min().unwrap_or(0);
    let right = shots.iter().map(|(x, _, img)| x + img.width() as i32).max().unwrap_or(0);
    let bottom = shots.iter().map(|(_, y, img)| y + img.height() as i32).max().unwrap_or(0);
    // Areas no monitor covers stay transparent.
    let mut canvas = RgbaImage::new((right - left) as u32, (bottom - top) as u32);
    for (x, y, img) in &shots {
        imageops::replace(&mut canvas, img, (x - left) as i64, (y - top) as i64);
    }
    Ok(canvas)
}

/// The overlay ships next to the app executable: in `target/<profile>` during development,
/// and as a bundled sidecar in installed builds.
fn overlay_exe() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("app executable has no parent directory")?;
    Ok(dir.join(format!("screencup-overlay{}", std::env::consts::EXE_SUFFIX)))
}

/// Returns `false` when the user cancelled the selection.
fn run_overlay(out: &Path) -> Result<bool, String> {
    let exe = overlay_exe()?;
    let output = Command::new(&exe)
        .arg("--out")
        .arg(out)
        .output()
        .map_err(|e| format!("{}: {e}", exe.display()))?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(String::from_utf8_lossy(&output.stderr).into_owned()),
    }
}
