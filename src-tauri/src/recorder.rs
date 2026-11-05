//! Screen recording through an ffmpeg child process.
//!
//! ffmpeg grabs the area with the platform's screen input (gdigrab on Windows, x11grab on
//! X11, avfoundation on macOS) and encodes H.264 into an MP4 in the library. Stopping writes
//! `q` to its stdin so ffmpeg finalises the file; cancelling kills it and drops the file.
//! While recording, a small control bar window (excluded from screen capture) shows the
//! elapsed time with Stop / Cancel.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

use crate::capture::{self, Area, helper_command};
use crate::{library, show_gallery};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecordKind {
    Region,
    Screen,
}

const FRAMERATE: &str = "30";
/// ffmpeg gets this long to finalise the MP4 after `q` before it is killed.
const STOP_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a fresh ffmpeg must survive before the recording counts as started.
const STARTUP_CHECK: Duration = Duration::from_millis(400);
const BAR_LABEL: &str = "recbar";
/// Control bar size in logical pixels; keep in sync with `.recbar` in src/styles.css.
const BAR_SIZE: (f64, f64) = (236.0, 44.0);
const BAR_GAP: f64 = 10.0;

struct Recording {
    child: Child,
    out: PathBuf,
    log: PathBuf,
}

#[derive(Default)]
pub struct Recorder(Mutex<Option<Recording>>);

/// Set from the hotkey until ffmpeg runs, so a second press during region selection is ignored.
static STARTING: AtomicBool = AtomicBool::new(false);

fn is_recording(app: &AppHandle) -> bool {
    app.state::<Recorder>().0.lock().map(|r| r.is_some()).unwrap_or(false)
}

// The commands are async: they open or destroy the control bar window, which deadlocks when
// done from a synchronous command on Windows.

#[tauri::command]
pub async fn toggle_recording(app: AppHandle, kind: RecordKind) {
    toggle(app, kind)
}

#[tauri::command]
pub async fn stop_recording(app: AppHandle) {
    stop(app)
}

#[tauri::command]
pub async fn cancel_recording(app: AppHandle) {
    cancel(app)
}

/// Starts a recording, or stops the running one (so the same hotkey toggles).
pub fn toggle(app: AppHandle, kind: RecordKind) {
    if is_recording(&app) {
        stop(app);
        return;
    }
    if STARTING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        capture::hide_gallery(&app);
        if let Err(e) = start(&app, kind) {
            eprintln!("recording failed: {e}");
            let _ = app.emit("recording-error", &e);
            // The gallery shows the error.
            show_gallery(&app);
        }
        STARTING.store(false, Ordering::SeqCst);
    });
}

fn start(app: &AppHandle, kind: RecordKind) -> Result<(), String> {
    let area = match kind {
        RecordKind::Region => match capture::select_region()? {
            Some(a) => a,
            None => return Ok(()),
        },
        RecordKind::Screen => capture::screen_under_cursor(app)?,
    };
    // yuv420p H.264 needs even dimensions.
    let area = Area { width: area.width & !1, height: area.height & !1, ..area };
    if area.width < 16 || area.height < 16 {
        return Err("area too small to record".into());
    }

    let ffmpeg = ffmpeg_exe()?;
    let out = library::new_capture_path(app)?.with_extension("mp4");
    let log = app.path().app_log_dir().map_err(|e| e.to_string())?.join("recording.log");
    for dir in [out.parent(), log.parent()].into_iter().flatten() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let mut child = helper_command(&ffmpeg)
        .args(["-hide_banner", "-loglevel", "warning", "-y"])
        .args(input_args(area))
        .args(encoder_args(&ffmpeg))
        .args(["-movflags", "+faststart"])
        .arg(&out)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(File::create(&log).map_err(|e| format!("{}: {e}", log.display()))?)
        .spawn()
        .map_err(|e| format!("{}: {e}", ffmpeg.display()))?;

    std::thread::sleep(STARTUP_CHECK);
    if let Ok(Some(status)) = child.try_wait() {
        let _ = std::fs::remove_file(&out);
        return Err(format!("ffmpeg exited at start ({status}): {}", read_log(&log)));
    }
    *app.state::<Recorder>().0.lock().map_err(|e| e.to_string())? = Some(Recording { child, out, log });
    open_bar(app, area)?;
    Ok(())
}

/// Finalises the running recording and adds it to the gallery.
pub fn stop(app: AppHandle) {
    let Some(mut rec) = app.state::<Recorder>().0.lock().ok().and_then(|mut r| r.take()) else { return };
    close_bar(&app);
    std::thread::spawn(move || {
        if let Some(stdin) = rec.child.stdin.as_mut() {
            let _ = stdin.write_all(b"q");
            let _ = stdin.flush();
        }
        drop(rec.child.stdin.take());
        match wait_with_timeout(&mut rec.child, STOP_TIMEOUT) {
            Some(status) if status.success() && rec.out.exists() => {
                let _ = app.emit("capture-added", &rec.out);
                show_gallery(&app);
            }
            status => {
                let msg = format!("ffmpeg did not finish cleanly ({status:?}): {}", read_log(&rec.log));
                eprintln!("{msg}");
                let _ = app.emit("recording-error", &msg);
                show_gallery(&app);
                // A partially written MP4 without its index is unplayable.
                let _ = std::fs::remove_file(&rec.out);
            }
        }
    });
}

/// Stops the running recording and throws the file away.
pub fn cancel(app: AppHandle) {
    let Some(mut rec) = app.state::<Recorder>().0.lock().ok().and_then(|mut r| r.take()) else { return };
    close_bar(&app);
    let _ = rec.child.kill();
    let _ = rec.child.wait();
    let _ = std::fs::remove_file(&rec.out);
}

fn wait_with_timeout(child: &mut Child, timeout: Duration) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    None
}

fn read_log(path: &Path) -> String {
    let mut text = String::new();
    let _ = File::open(path).and_then(|mut f| f.read_to_string(&mut text));
    text.trim().to_owned()
}

// --- ffmpeg ----------------------------------------------------------------------------

/// `SCREENCUP_FFMPEG`, then an ffmpeg bundled next to the app, then one on `PATH`.
pub fn ffmpeg_exe() -> Result<PathBuf, String> {
    if let Some(p) = std::env::var_os("SCREENCUP_FFMPEG") {
        return Ok(p.into());
    }
    let name = format!("ffmpeg{}", std::env::consts::EXE_SUFFIX);
    let beside = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join(&name)));
    let on_path = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).map(|d| d.join(&name)).collect::<Vec<_>>())
        .unwrap_or_default();
    beside
        .into_iter()
        .chain(on_path)
        .find(|p| p.is_file())
        .ok_or_else(|| "ffmpeg not found: install it or place it next to Screencup".into())
}

fn input_args(a: Area) -> Vec<String> {
    let size = format!("{}x{}", a.width, a.height);
    #[cfg(target_os = "windows")]
    let args = vec![
        "-f".into(),
        "gdigrab".into(),
        "-framerate".into(),
        FRAMERATE.into(),
        "-draw_mouse".into(),
        "1".into(),
        "-offset_x".into(),
        a.x.to_string(),
        "-offset_y".into(),
        a.y.to_string(),
        "-video_size".into(),
        size,
        "-i".into(),
        "desktop".into(),
    ];
    #[cfg(target_os = "linux")]
    let args = {
        let display = std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into());
        vec![
            "-f".into(),
            "x11grab".into(),
            "-framerate".into(),
            FRAMERATE.into(),
            "-draw_mouse".into(),
            "1".into(),
            "-video_size".into(),
            size,
            "-i".into(),
            format!("{display}+{},{}", a.x, a.y),
        ]
    };
    // avfoundation records a whole display; the area is cut out with a crop filter.
    // Assumes the main display and an area expressed in its pixels.
    #[cfg(target_os = "macos")]
    let args = {
        let _ = size;
        vec![
            "-f".into(),
            "avfoundation".into(),
            "-framerate".into(),
            FRAMERATE.into(),
            "-capture_cursor".into(),
            "1".into(),
            "-i".into(),
            "Capture screen 0:none".into(),
            "-vf".into(),
            format!("crop={}:{}:{}:{}", a.width, a.height, a.x, a.y),
        ]
    };
    args
}

/// Picks the best H.264 encoder this ffmpeg offers (probed once).
fn encoder_args(ffmpeg: &Path) -> Vec<&'static str> {
    static ENCODERS: OnceLock<String> = OnceLock::new();
    let list = ENCODERS.get_or_init(|| {
        helper_command(ffmpeg)
            .args(["-hide_banner", "-encoders"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default()
    });
    let has = |name: &str| list.split_whitespace().any(|w| w == name);
    if has("libx264") {
        vec!["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"]
    } else if has("h264_mf") {
        vec!["-c:v", "h264_mf", "-b:v", "8M", "-pix_fmt", "nv12"]
    } else if has("h264_videotoolbox") {
        vec!["-c:v", "h264_videotoolbox", "-b:v", "8M", "-pix_fmt", "yuv420p"]
    } else if has("libopenh264") {
        vec!["-c:v", "libopenh264", "-b:v", "8M", "-pix_fmt", "yuv420p"]
    } else {
        vec!["-c:v", "mpeg4", "-q:v", "3", "-pix_fmt", "yuv420p"]
    }
}

/// First frame of a video as PNG bytes, fitted in a `size` x `size` box.
pub fn video_frame(path: &Path, size: u32) -> Result<Vec<u8>, String> {
    let ffmpeg = ffmpeg_exe()?;
    let output = helper_command(&ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-i"])
        .arg(path)
        .args(["-frames:v", "1", "-vf"])
        .arg(format!("scale={size}:{size}:force_original_aspect_ratio=decrease"))
        .args(["-f", "image2pipe", "-c:v", "png", "-"])
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() && !output.stdout.is_empty() {
        Ok(output.stdout)
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

// --- control bar -----------------------------------------------------------------------

/// Places the bar under the recorded area, above it when there is no room, or inside its
/// bottom edge for a full-screen recording. It is excluded from screen capture anyway.
fn open_bar(app: &AppHandle, area: Area) -> Result<(), String> {
    let cx = area.x as f64 + area.width as f64 / 2.0;
    let cy = area.y as f64 + area.height as f64 / 2.0;
    let monitor = app.monitor_from_point(cx, cy).ok().flatten();
    let scale = monitor.as_ref().map_or(1.0, |m| m.scale_factor());
    let (w, h, gap) = (BAR_SIZE.0 * scale, BAR_SIZE.1 * scale, BAR_GAP * scale);
    let (top, bottom) = monitor.as_ref().map_or((f64::MIN, f64::MAX), |m| {
        let wa = m.work_area();
        (wa.position.y as f64, wa.position.y as f64 + wa.size.height as f64)
    });
    let below = area.y as f64 + area.height as f64 + gap;
    let above = area.y as f64 - gap - h;
    let y = if below + h <= bottom {
        below
    } else if above >= top {
        above
    } else {
        area.y as f64 + area.height as f64 - h - gap * 4.0
    };
    let started_ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);

    let bar = WebviewWindowBuilder::new(app, BAR_LABEL, WebviewUrl::App("index.html".into()))
        .initialization_script(format!("window.__SCREENCUP_RECBAR__ = {{ startedMs: {started_ms} }};"))
        .title("Screencup recording")
        .inner_size(BAR_SIZE.0, BAR_SIZE.1)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .content_protected(true)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = bar.set_position(PhysicalPosition::new((cx - w / 2.0) as i32, y as i32));
    let _ = bar.show();
    Ok(())
}

fn close_bar(app: &AppHandle) {
    if let Some(bar) = app.get_webview_window(BAR_LABEL) {
        let _ = bar.destroy();
    }
}
