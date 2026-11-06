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

use crate::{clipboard, library, settings, show_gallery};

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
                let prefs = settings::load(&app);
                if prefs.copy_after_capture
                    && let Err(e) = clipboard_copy(&app, &path)
                {
                    eprintln!("copy to clipboard failed: {e}");
                }
                let _ = app.emit("capture-added", &path);
                crate::library::enforce_limit_async(&app);
                if prefs.show_gallery_after_capture || gallery_was_visible {
                    show_gallery(&app);
                }
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

pub(crate) fn hide_gallery(app: &AppHandle) -> bool {
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

/// A command for a helper process that never flashes a console window on Windows.
pub(crate) fn helper_command(program: &Path) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Runs the overlay with `args`; returns its JSON stdout, or `None` when the user cancelled.
fn overlay(args: &[&std::ffi::OsStr]) -> Result<Option<String>, String> {
    let exe = overlay_exe()?;
    let output = helper_command(&exe).args(args).output().map_err(|e| format!("{}: {e}", exe.display()))?;
    match output.status.code() {
        Some(0) => Ok(Some(String::from_utf8_lossy(&output.stdout).into_owned())),
        Some(1) => Ok(None),
        _ => Err(String::from_utf8_lossy(&output.stderr).into_owned()),
    }
}

/// Returns `false` when the user cancelled the selection.
fn run_overlay(out: &Path) -> Result<bool, String> {
    Ok(overlay(&["--out".as_ref(), out.as_os_str()])?.is_some())
}

/// Area in physical virtual-desktop pixels.
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Lets the user pick an area on the frozen screen without saving anything.
pub(crate) fn select_region() -> Result<Option<Area>, String> {
    #[derive(Deserialize)]
    struct Selection {
        rect: Area,
    }
    let Some(json) = overlay(&["--select".as_ref()])? else { return Ok(None) };
    serde_json::from_str::<Selection>(&json).map(|s| Some(s.rect)).map_err(|e| format!("{e}: {json}"))
}

/// The whole monitor under the mouse cursor.
pub(crate) fn screen_under_cursor(app: &AppHandle) -> Result<Area, String> {
    let p = app.cursor_position().map_err(|e| e.to_string())?;
    let m = xcap::Monitor::from_point(p.x as i32, p.y as i32).map_err(|e| e.to_string())?;
    let err = |e: xcap::XCapError| e.to_string();
    Ok(Area {
        x: m.x().map_err(err)?,
        y: m.y().map_err(err)?,
        width: m.width().map_err(err)?,
        height: m.height().map_err(err)?,
    })
}
