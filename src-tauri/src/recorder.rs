//! Screen recording through an ffmpeg child process.
//!
//! ffmpeg grabs the area with the platform's screen input (gdigrab on Windows, x11grab on
//! X11, avfoundation on macOS) and encodes H.264 into an MP4 in the library. Stopping writes
//! `q` to its stdin so ffmpeg finalises the file; cancelling kills it and drops the file.
//! Picking an area does not start recording: it first shows a dashed frame around the area
//! and a control panel (record button, microphone / system audio / click toggles). Record on
//! the panel, or the hotkey again, starts; the panel then shows the elapsed time with Stop /
//! Cancel and the frame stays. Frame and panel are excluded from screen capture.
//!
//! With audio enabled in the settings, the video goes to a work file while the microphone
//! and/or system audio are written to WAVs (see `audio`); on stop everything is muxed into
//! the library MP4, aligning the tracks on their ends since all stop at the same moment.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

use crate::audio::{self, AudioCapture, Source};
use crate::capture::{self, Area, helper_command};
use crate::clickfx::ClickFx;
use crate::{library, settings, show_gallery};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecordKind {
    Region,
    Screen,
}

/// ffmpeg gets this long to finalise the MP4 after `q` before it is killed.
const STOP_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a fresh ffmpeg must survive before the recording counts as started.
const STARTUP_CHECK: Duration = Duration::from_millis(400);
const BAR_LABEL: &str = "recbar";
/// Control panel size in logical pixels; keep in sync with `.recbar` in src/styles.css.
const BAR_SIZE: (f64, f64) = (480.0, 76.0);
const BAR_GAP: f64 = 12.0;
const FRAME_LABEL: &str = "recframe";
/// Width of the ring around the area where the dashed frame is drawn, in logical pixels:
/// the frame stays outside the recorded pixels.
const FRAME_MARGIN: f64 = 4.0;

struct Recording {
    child: Child,
    /// Final file in the library.
    out: PathBuf,
    /// File ffmpeg writes: `out` itself, or a work file when audio must be muxed in.
    video: PathBuf,
    log: PathBuf,
    audio: Vec<AudioCapture>,
    /// Click highlights drawn over the area while recording, when enabled.
    click_fx: Option<ClickFx>,
}

#[derive(Default)]
pub struct Recorder {
    running: Mutex<Option<Recording>>,
    /// Area picked and shown with frame and panel, waiting for Record.
    prepared: Mutex<Option<Area>>,
}

/// Set from the hotkey until ffmpeg runs, so a second press during region selection is ignored.
static STARTING: AtomicBool = AtomicBool::new(false);

fn is_recording(app: &AppHandle) -> bool {
    app.state::<Recorder>().running.lock().map(|r| r.is_some()).unwrap_or(false)
}

fn take_prepared(app: &AppHandle) -> Option<Area> {
    app.state::<Recorder>().prepared.lock().ok().and_then(|mut p| p.take())
}

fn is_prepared(app: &AppHandle) -> bool {
    app.state::<Recorder>().prepared.lock().map(|p| p.is_some()).unwrap_or(false)
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

/// Record button of the panel.
#[tauri::command]
pub async fn start_prepared(app: AppHandle) {
    begin_reporting(&app)
}

/// "Riseleziona" on the panel: drop the area and pick a new one.
#[tauri::command]
pub async fn reselect_region(app: AppHandle) {
    if take_prepared(&app).is_none() {
        return;
    }
    close_windows(&app);
    toggle(app, RecordKind::Region);
}

#[tauri::command]
pub async fn cancel_recording(app: AppHandle) {
    cancel(app)
}

/// The hotkey cycles: pick an area (frame + panel) -> record -> stop.
pub fn toggle(app: AppHandle, kind: RecordKind) {
    if is_recording(&app) {
        stop(app);
        return;
    }
    if is_prepared(&app) {
        std::thread::spawn(move || begin_reporting(&app));
        return;
    }
    if STARTING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        capture::hide_gallery(&app);
        if let Err(e) = prepare(&app, kind) {
            report_error(&app, &e);
        }
        STARTING.store(false, Ordering::SeqCst);
    });
}

fn report_error(app: &AppHandle, e: &str) {
    eprintln!("recording failed: {e}");
    close_windows(app);
    let _ = app.emit("recording-error", e);
    // The gallery shows the error.
    show_gallery(app);
}

/// Picks the area and shows frame and panel; recording waits for Record.
fn prepare(app: &AppHandle, kind: RecordKind) -> Result<(), String> {
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
    *app.state::<Recorder>().prepared.lock().map_err(|e| e.to_string())? = Some(area);
    open_frame(app, area)?;
    open_bar(app, area)?;
    Ok(())
}

fn begin_reporting(app: &AppHandle) {
    if let Err(e) = begin(app) {
        report_error(app, &e);
    }
}

/// Starts recording the prepared area.
fn begin(app: &AppHandle) -> Result<(), String> {
    let Some(area) = take_prepared(app) else { return Ok(()) };

    let ffmpeg = ffmpeg_exe()?;
    let out = library::new_capture_path(app)?.with_extension("mp4");
    let log = app.path().app_log_dir().map_err(|e| e.to_string())?.join("recording.log");
    let work = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("recording");
    for dir in [out.parent(), log.parent(), Some(work.as_path())].into_iter().flatten() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let stem = out.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();

    // A source that cannot be opened is skipped with a warning; the video still records.
    let prefs = settings::load(app);
    let wanted = [
        (prefs.record_microphone, Source::Microphone, "mic"),
        (prefs.record_system_audio, Source::System, "system"),
    ];
    let mut audio = Vec::new();
    for (_, source, tag) in wanted.into_iter().filter(|(on, ..)| *on) {
        match AudioCapture::start(source, work.join(format!("{stem}-{tag}.wav"))) {
            Ok(c) => audio.push(c),
            Err(e) => {
                let _ = app.emit("recording-warning", format!("{}: {e}", source.label()));
            }
        }
    }
    let video = if audio.is_empty() { out.clone() } else { work.join(format!("{stem}-video.mp4")) };
    let framerate = prefs.framerate.to_string();

    let spawned = File::create(&log).map_err(|e| format!("{}: {e}", log.display())).and_then(|stderr| {
        helper_command(&ffmpeg)
            .args(["-hide_banner", "-loglevel", "warning", "-y"])
            .args(input_args(area, &framerate))
            .args(encoder_args(&ffmpeg))
            .args(["-movflags", "+faststart"])
            .arg(&video)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(stderr)
            .spawn()
            .map_err(|e| format!("{}: {e}", ffmpeg.display()))
    });
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => {
            discard_audio(audio);
            return Err(e);
        }
    };

    std::thread::sleep(STARTUP_CHECK);
    if let Ok(Some(status)) = child.try_wait() {
        discard_audio(audio);
        let _ = std::fs::remove_file(&video);
        return Err(format!("ffmpeg exited at start ({status}): {}", read_log(&log)));
    }
    let mic = audio.iter().any(|c| matches!(c.source, Source::Microphone));
    let system = audio.iter().any(|c| matches!(c.source, Source::System));
    *app.state::<Recorder>().running.lock().map_err(|e| e.to_string())? = Some(Recording {
        child,
        out,
        video,
        log,
        audio,
        click_fx: start_click_fx(app, area, prefs.show_clicks),
    });
    let started_ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    let _ = app.emit_to(BAR_LABEL, "recording-started", RecordingStarted { started_ms, mic, system });
    Ok(())
}

/// Tells the panel to switch to its recording look.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingStarted {
    started_ms: u64,
    mic: bool,
    system: bool,
}

fn start_click_fx(app: &AppHandle, area: Area, enabled: bool) -> Option<ClickFx> {
    if !enabled {
        return None;
    }
    ClickFx::start(app, area).map_err(|e| eprintln!("click highlights unavailable: {e}")).ok()
}

fn discard_audio(audio: Vec<AudioCapture>) {
    for c in audio {
        if let Ok(wav) = c.finish() {
            let _ = std::fs::remove_file(wav);
        }
    }
}

/// Finalises the running recording and adds it to the gallery.
pub fn stop(app: AppHandle) {
    let Some(mut rec) = app.state::<Recorder>().running.lock().ok().and_then(|mut r| r.take()) else {
        return;
    };
    close_windows(&app);
    if let Some(fx) = rec.click_fx.take() {
        fx.finish(&app);
    }
    std::thread::spawn(move || {
        // Video and audio stop at the same moment: the mux aligns the tracks on their ends.
        for c in &rec.audio {
            c.request_stop();
        }
        if let Some(stdin) = rec.child.stdin.as_mut() {
            let _ = stdin.write_all(b"q");
            let _ = stdin.flush();
        }
        drop(rec.child.stdin.take());
        let wavs: Vec<PathBuf> = rec
            .audio
            .drain(..)
            .filter_map(|c| {
                let label = c.source.label();
                c.finish().map_err(|e| eprintln!("{label}: {e}")).ok()
            })
            .collect();
        let result = match wait_with_timeout(&mut rec.child, STOP_TIMEOUT) {
            Some(s) if s.success() && rec.video.exists() => finish_file(&app, &rec, &wavs),
            status => Err(format!("ffmpeg did not finish cleanly ({status:?}): {}", read_log(&rec.log))),
        };
        for wav in &wavs {
            let _ = std::fs::remove_file(wav);
        }
        match result {
            Ok(()) => {
                let _ = app.emit("capture-added", &rec.out);
                if settings::load(&app).show_gallery_after_capture {
                    show_gallery(&app);
                }
            }
            Err(msg) => {
                eprintln!("{msg}");
                let _ = app.emit("recording-error", &msg);
                // A partially written MP4 without its index is unplayable.
                let _ = std::fs::remove_file(&rec.video);
                show_gallery(&app);
            }
        }
    });
}

/// Moves the recording into the library, muxing the audio tracks in when there are any.
/// If muxing fails the silent video is kept rather than lost.
fn finish_file(app: &AppHandle, rec: &Recording, wavs: &[PathBuf]) -> Result<(), String> {
    if rec.video == rec.out {
        return Ok(());
    }
    if !wavs.is_empty() {
        match mux(&rec.video, wavs, &rec.out) {
            Ok(()) => {
                let _ = std::fs::remove_file(&rec.video);
                return Ok(());
            }
            Err(e) => {
                let _ = app.emit("recording-warning", format!("audio not added: {e}"));
            }
        }
    }
    move_file(&rec.video, &rec.out)
}

fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    // The work dir may be on another volume than the library, where rename fails.
    std::fs::rename(from, to)
        .or_else(|_| std::fs::copy(from, to).and_then(|_| std::fs::remove_file(from)))
        .map_err(|e| format!("{}: {e}", to.display()))
}

fn mux(video: &Path, wavs: &[PathBuf], out: &Path) -> Result<(), String> {
    let ffmpeg = ffmpeg_exe()?;
    let video_secs = media_seconds(&ffmpeg, video)?;
    let mut cmd = helper_command(&ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "warning", "-y", "-i"]).arg(video);
    for wav in wavs {
        // Positive: the audio started before the first video frame, so skip its head.
        let lead = audio::wav_seconds(wav)? - video_secs;
        if lead > 0.0 {
            cmd.args(["-ss", &format!("{lead:.3}")]);
        } else if lead < 0.0 {
            cmd.args(["-itsoffset", &format!("{:.3}", -lead)]);
        }
        cmd.arg("-i").arg(wav);
    }
    if wavs.len() == 1 {
        cmd.args(["-map", "0:v", "-map", "1:a"]);
    } else {
        let inputs: String = (1..=wavs.len()).map(|i| format!("[{i}:a]")).collect();
        let graph = format!("{inputs}amix=inputs={}:duration=longest:normalize=0[a]", wavs.len());
        cmd.args(["-filter_complex", &graph, "-map", "0:v", "-map", "[a]"]);
    }
    cmd.args(["-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart"])
        .arg(out);
    let output = cmd.output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        let _ = std::fs::remove_file(out);
        Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
    }
}

/// Duration of a media file, parsed from ffmpeg's `Duration: HH:MM:SS.ss` banner.
fn media_seconds(ffmpeg: &Path, path: &Path) -> Result<f64, String> {
    let output =
        helper_command(ffmpeg).args(["-hide_banner", "-i"]).arg(path).output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&output.stderr);
    let stamp = text
        .split("Duration: ")
        .nth(1)
        .and_then(|rest| rest.split(',').next())
        .ok_or_else(|| format!("no duration for {}", path.display()))?;
    stamp
        .trim()
        .split(':')
        .try_fold(0.0, |acc, part| part.parse::<f64>().map(|v| acc * 60.0 + v))
        .map_err(|e| format!("{stamp}: {e}"))
}

/// Stops the running recording and throws the file away, or drops the prepared area.
pub fn cancel(app: AppHandle) {
    if take_prepared(&app).is_some() {
        close_windows(&app);
        return;
    }
    let Some(mut rec) = app.state::<Recorder>().running.lock().ok().and_then(|mut r| r.take()) else {
        return;
    };
    close_windows(&app);
    if let Some(fx) = rec.click_fx.take() {
        fx.finish(&app);
    }
    let _ = rec.child.kill();
    let _ = rec.child.wait();
    discard_audio(std::mem::take(&mut rec.audio));
    let _ = std::fs::remove_file(&rec.video);
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

fn input_args(a: Area, framerate: &str) -> Vec<String> {
    let size = format!("{}x{}", a.width, a.height);
    #[cfg(target_os = "windows")]
    let args = vec![
        "-f".into(),
        "gdigrab".into(),
        "-framerate".into(),
        framerate.into(),
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
            framerate.into(),
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
            framerate.into(),
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

/// Places the panel under the recorded area, above it when there is no room, or inside its
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
    let bar = WebviewWindowBuilder::new(app, BAR_LABEL, WebviewUrl::App("index.html".into()))
        .initialization_script("window.__SCREENCUP_RECBAR__ = true;")
        .title("Screencup recording")
        .inner_size(BAR_SIZE.0, BAR_SIZE.1)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .content_protected(true)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = bar.set_position(PhysicalPosition::new((cx - w / 2.0) as i32, y as i32));
    let _ = bar.show();
    let _ = bar.set_focus();
    Ok(())
}

/// Dashed frame drawn in a thin ring just outside the area: click-through, and excluded
/// from screen capture, so it never shows in the video.
fn open_frame(app: &AppHandle, area: Area) -> Result<(), String> {
    let scale =
        app.monitor_from_point(area.x as f64, area.y as f64).ok().flatten().map_or(1.0, |m| m.scale_factor());
    let m = (FRAME_MARGIN * scale).round() as i32;
    let frame = WebviewWindowBuilder::new(app, FRAME_LABEL, WebviewUrl::App("index.html".into()))
        .initialization_script(format!(
            "window.__SCREENCUP_RECFRAME__ = {{ width: {}, height: {} }};",
            area.width, area.height
        ))
        .title("Screencup area")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focusable(false)
        .focused(false)
        .content_protected(true)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = frame.set_position(PhysicalPosition::new(area.x - m, area.y - m));
    let _ = frame.set_size(PhysicalSize::new(area.width + 2 * m as u32, area.height + 2 * m as u32));
    let _ = frame.set_ignore_cursor_events(true);
    let _ = frame.show();
    Ok(())
}

fn close_windows(app: &AppHandle) {
    for label in [BAR_LABEL, FRAME_LABEL] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.destroy();
        }
    }
}
