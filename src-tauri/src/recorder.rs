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
//! and/or system audio are written to WAVs (see `audio`); when the segment ends everything is
//! muxed, aligning the tracks on their ends since all stop at the same moment.
//!
//! Pause ends the current segment (ffmpeg cannot pause a screen grab); Resume starts a new
//! one with the same settings. Stop joins the segments into the library MP4 without
//! re-encoding.

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
const BAR_SIZE: (f64, f64) = (560.0, 76.0);
const BAR_GAP: f64 = 12.0;
const FRAME_LABEL: &str = "recframe";
/// Width of the ring around the area where the dashed frame is drawn, in logical pixels:
/// the frame stays outside the recorded pixels. While preparing, the ring is also the grip
/// to resize the area. Keep in sync with `RecFrame` in src/RecBar.tsx.
const FRAME_MARGIN: f64 = 8.0;
/// Corner resize handles: squares of this side from the window corners (they reach past
/// the ring into the area), in logical pixels.
const FRAME_CORNER: f64 = FRAME_MARGIN + 6.0;
/// Diameter of the move handle in the middle of the area, in logical pixels.
const FRAME_GRIP: f64 = 44.0;
/// Box for the size label at the top right inside the area, in logical pixels; the window
/// shape keeps it visible. Keep in sync with `.recframe-size` in src/styles.css.
#[cfg_attr(not(windows), allow(dead_code))] // used by the Windows window shape only
const FRAME_LABEL_BOX: (f64, f64) = (96.0, 22.0);

/// One stretch of recording between start / resume and pause / stop.
struct Segment {
    child: Child,
    /// File ffmpeg writes: the segment itself, or a video-only work file when audio must be
    /// muxed in.
    video: PathBuf,
    /// The finished segment, with its audio.
    file: PathBuf,
    audio: Vec<AudioCapture>,
    started: Instant,
}

struct Recording {
    area: Area,
    framerate: String,
    ffmpeg: PathBuf,
    /// Final file in the library.
    out: PathBuf,
    /// Work folder and file stem for segments and WAVs.
    work: PathBuf,
    stem: String,
    log: PathBuf,
    /// Audio sources asked for in the settings when recording started.
    sources: Vec<Source>,
    /// The segment being recorded; `None` while paused.
    segment: Option<Segment>,
    /// Finished segments, in order.
    done: Vec<PathBuf>,
    /// Recorded time of the finished segments.
    elapsed: Duration,
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

/// Pause button of the panel: ends the current segment.
#[tauri::command]
pub async fn pause_recording(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || pause(&app)).await.map_err(|e| e.to_string())?
}

/// Resume button of the panel: starts a new segment.
#[tauri::command]
pub async fn resume_recording(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || resume(&app)).await.map_err(|e| e.to_string())?
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
    let area = even_area(area);
    if area.width < 16 || area.height < 16 {
        return Err("area too small to record".into());
    }
    *app.state::<Recorder>().prepared.lock().map_err(|e| e.to_string())? = Some(area);
    open_frame(app, area)?;
    open_bar(app, area)?;
    if settings::load(app).record_webcam
        && let Err(e) = crate::webcam::open(app, area)
    {
        eprintln!("webcam overlay: {e}");
    }
    Ok(())
}

/// The area being prepared or recorded, for windows placed over it.
pub fn current_area(app: &AppHandle) -> Option<Area> {
    if let Some(frame) = app.get_webview_window(FRAME_LABEL) {
        return Some(frame_area(&frame));
    }
    let state = app.state::<Recorder>();
    let prepared = *state.prepared.lock().ok()?;
    prepared.or_else(|| state.running.lock().ok()?.as_ref().map(|r| r.area))
}

fn begin_reporting(app: &AppHandle) {
    if let Err(e) = begin(app) {
        report_error(app, &e);
    }
}

/// Starts recording the prepared area.
fn begin(app: &AppHandle) -> Result<(), String> {
    let Some(prepared) = take_prepared(app) else { return Ok(()) };
    // The frame may have been moved or resized since the area was picked.
    let frame = app.get_webview_window(FRAME_LABEL);
    let area = even_area(frame.as_ref().map_or(prepared, frame_area));
    if area.width < 16 || area.height < 16 {
        return Err("area too small to record".into());
    }
    if let Some(frame) = &frame {
        lock_frame(frame, area);
    }

    let ffmpeg = ffmpeg_exe()?;
    let out = library::new_capture_path(app)?.with_extension("mp4");
    let log = app.path().app_log_dir().map_err(|e| e.to_string())?.join("recording.log");
    let work = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("recording");
    for dir in [out.parent(), log.parent(), Some(work.as_path())].into_iter().flatten() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let stem = out.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let prefs = settings::load(app);
    let sources =
        [(prefs.record_microphone, Source::Microphone), (prefs.record_system_audio, Source::System)]
            .into_iter()
            .filter_map(|(on, source)| on.then_some(source))
            .collect();
    let mut rec = Recording {
        area,
        framerate: prefs.framerate.to_string(),
        ffmpeg,
        out,
        work,
        stem,
        log,
        sources,
        segment: None,
        done: Vec::new(),
        elapsed: Duration::ZERO,
        click_fx: None,
    };
    let segment = start_segment(app, &rec)?;
    let mic = segment.audio.iter().any(|c| matches!(c.source, Source::Microphone));
    let system = segment.audio.iter().any(|c| matches!(c.source, Source::System));
    rec.segment = Some(segment);
    rec.click_fx = start_click_fx(app, area, prefs.show_clicks);
    *app.state::<Recorder>().running.lock().map_err(|e| e.to_string())? = Some(rec);
    let started = RecordingStarted { started_ms: now_ms(), mic, system };
    let _ = app.emit_to(BAR_LABEL, "recording-started", &started);
    let _ = app.emit_to(FRAME_LABEL, "recording-started", &started);
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Starts ffmpeg and the audio captures for the next segment of `rec`.
fn start_segment(app: &AppHandle, rec: &Recording) -> Result<Segment, String> {
    let n = rec.done.len();
    let base = rec.work.join(format!("{}-{n}", rec.stem));
    // A source that cannot be opened is skipped with a warning; the video still records.
    let mut audio = Vec::new();
    for &source in &rec.sources {
        let wav = base.with_file_name(format!("{}-{n}-{}.wav", rec.stem, source.label().replace(' ', "-")));
        match AudioCapture::start(source, wav) {
            Ok(c) => audio.push(c),
            Err(e) => {
                let _ = app.emit("recording-warning", format!("{}: {e}", source.label()));
            }
        }
    }
    let file = base.with_extension("mp4");
    let video = if audio.is_empty() {
        file.clone()
    } else {
        base.with_file_name(format!("{}-{n}-video.mp4", rec.stem))
    };

    let spawned =
        File::create(&rec.log).map_err(|e| format!("{}: {e}", rec.log.display())).and_then(|stderr| {
            helper_command(&rec.ffmpeg)
                .args(["-hide_banner", "-loglevel", "warning", "-y"])
                .args(input_args(rec.area, &rec.framerate))
                .args(encoder_args(&rec.ffmpeg))
                .args(["-movflags", "+faststart"])
                .arg(&video)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(stderr)
                .spawn()
                .map_err(|e| format!("{}: {e}", rec.ffmpeg.display()))
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
        return Err(format!("ffmpeg exited at start ({status}): {}", read_log(&rec.log)));
    }
    Ok(Segment { child, video, file, audio, started: Instant::now() })
}

/// Stops ffmpeg and the audio captures of a segment and muxes them into `segment.file`.
/// If muxing fails the silent video is kept rather than lost.
fn finish_segment(app: &AppHandle, mut seg: Segment, log: &Path) -> Result<PathBuf, String> {
    // Video and audio stop at the same moment: the mux aligns the tracks on their ends.
    for c in &seg.audio {
        c.request_stop();
    }
    if let Some(stdin) = seg.child.stdin.as_mut() {
        let _ = stdin.write_all(b"q");
        let _ = stdin.flush();
    }
    drop(seg.child.stdin.take());
    let wavs: Vec<PathBuf> = seg
        .audio
        .drain(..)
        .filter_map(|c| {
            let label = c.source.label();
            c.finish().map_err(|e| eprintln!("{label}: {e}")).ok()
        })
        .collect();
    let result = match wait_with_timeout(&mut seg.child, STOP_TIMEOUT) {
        Some(s) if s.success() && seg.video.exists() => {
            if seg.video == seg.file {
                Ok(())
            } else if !wavs.is_empty() && mux(&seg.video, &wavs, &seg.file).is_ok() {
                let _ = std::fs::remove_file(&seg.video);
                Ok(())
            } else {
                if !wavs.is_empty() {
                    let _ = app.emit("recording-warning", "audio not added to part of the recording");
                }
                move_file(&seg.video, &seg.file)
            }
        }
        status => Err(format!("ffmpeg did not finish cleanly ({status:?}): {}", read_log(log))),
    };
    for wav in &wavs {
        let _ = std::fs::remove_file(wav);
    }
    if result.is_err() {
        // A partially written MP4 without its index is unplayable.
        let _ = std::fs::remove_file(&seg.video);
    }
    result.map(|()| seg.file)
}

/// Ends the current segment; the panel shows the paused time.
fn pause(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<Recorder>();
    let mut guard = state.running.lock().map_err(|e| e.to_string())?;
    let Some(rec) = guard.as_mut() else { return Ok(()) };
    let Some(seg) = rec.segment.take() else { return Ok(()) };
    rec.elapsed += seg.started.elapsed();
    let file = finish_segment(app, seg, &rec.log)?;
    rec.done.push(file);
    let elapsed_ms = rec.elapsed.as_millis() as u64;
    drop(guard);
    let _ = app.emit_to(BAR_LABEL, "recording-paused", elapsed_ms);
    let _ = app.emit_to(FRAME_LABEL, "recording-paused", elapsed_ms);
    Ok(())
}

/// Starts a new segment after a pause.
fn resume(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<Recorder>();
    let mut guard = state.running.lock().map_err(|e| e.to_string())?;
    let Some(rec) = guard.as_mut() else { return Ok(()) };
    if rec.segment.is_some() {
        return Ok(());
    }
    let seg = start_segment(app, rec)?;
    let mic = seg.audio.iter().any(|c| matches!(c.source, Source::Microphone));
    let system = seg.audio.iter().any(|c| matches!(c.source, Source::System));
    rec.segment = Some(seg);
    // The panel counts from a start shifted back by the time already recorded.
    let started = RecordingStarted { started_ms: now_ms() - rec.elapsed.as_millis() as u64, mic, system };
    drop(guard);
    let _ = app.emit_to(BAR_LABEL, "recording-started", &started);
    let _ = app.emit_to(FRAME_LABEL, "recording-started", &started);
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
        let mut result = Ok(());
        if let Some(seg) = rec.segment.take() {
            match finish_segment(&app, seg, &rec.log) {
                Ok(file) => rec.done.push(file),
                Err(e) => result = Err(e),
            }
        }
        // Whatever was recorded before a failing last segment is still saved.
        let saved = match rec.done.len() {
            0 => Err(result.err().unwrap_or_else(|| "nothing recorded".into())),
            _ => join_segments(&app, &rec),
        };
        for part in &rec.done {
            let _ = std::fs::remove_file(part);
        }
        match saved {
            Ok(files) => {
                for file in files {
                    let _ = app.emit("capture-added", &file);
                }
                crate::library::enforce_limit_async(&app);
                if settings::load(&app).show_gallery_after_capture {
                    show_gallery(&app);
                }
            }
            Err(msg) => {
                eprintln!("{msg}");
                let _ = app.emit("recording-error", &msg);
                show_gallery(&app);
            }
        }
    });
}

/// Puts the finished segments in the library: one file, or, when they cannot be joined
/// (an audio device lost between segments changes the streams), one file per segment.
fn join_segments(app: &AppHandle, rec: &Recording) -> Result<Vec<PathBuf>, String> {
    if let [only] = rec.done.as_slice() {
        move_file(only, &rec.out)?;
        return Ok(vec![rec.out.clone()]);
    }
    match concat(&rec.ffmpeg, &rec.done, &rec.out, &rec.work.join(format!("{}-parts.txt", rec.stem))) {
        Ok(()) => Ok(vec![rec.out.clone()]),
        Err(e) => {
            let _ = app.emit("recording-warning", format!("parts saved separately: {e}"));
            let mut files = Vec::new();
            for (i, part) in rec.done.iter().enumerate() {
                let to = rec.out.with_file_name(format!("{}-part{}.mp4", rec.stem, i + 1));
                move_file(part, &to)?;
                files.push(to);
            }
            Ok(files)
        }
    }
}

/// Joins MP4s with identical streams without re-encoding (ffmpeg concat demuxer).
fn concat(ffmpeg: &Path, parts: &[PathBuf], out: &Path, list: &Path) -> Result<(), String> {
    let text: String = parts
        .iter()
        .map(|p| format!("file '{}'\n", p.to_string_lossy().replace('\\', "/").replace('\'', "'\\''")))
        .collect();
    std::fs::write(list, text).map_err(|e| format!("{}: {e}", list.display()))?;
    let output = helper_command(ffmpeg)
        .args(["-hide_banner", "-loglevel", "warning", "-y", "-f", "concat", "-safe", "0", "-i"])
        .arg(list)
        .args(["-c", "copy", "-movflags", "+faststart"])
        .arg(out)
        .output()
        .map_err(|e| e.to_string());
    let _ = std::fs::remove_file(list);
    let output = output?;
    if output.status.success() {
        Ok(())
    } else {
        let _ = std::fs::remove_file(out);
        Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
    }
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
    if let Some(mut seg) = rec.segment.take() {
        let _ = seg.child.kill();
        let _ = seg.child.wait();
        discard_audio(std::mem::take(&mut seg.audio));
        let _ = std::fs::remove_file(&seg.video);
    }
    for part in &rec.done {
        let _ = std::fs::remove_file(part);
    }
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
pub(crate) fn encoder_args(ffmpeg: &Path) -> Vec<&'static str> {
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

/// Where the panel goes for `area`: centred under it, above it when there is no room, or
/// inside its bottom edge for a full-screen recording.
fn bar_position(app: &AppHandle, area: Area) -> PhysicalPosition<i32> {
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
    PhysicalPosition::new((cx - w / 2.0) as i32, y as i32)
}

/// Places the panel under the recorded area, above it when there is no room, or inside its
/// bottom edge for a full-screen recording. It is excluded from screen capture anyway.
fn open_bar(app: &AppHandle, area: Area) -> Result<(), String> {
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
    let _ = bar.set_position(bar_position(app, area));
    let _ = bar.show();
    let _ = bar.set_focus();
    Ok(())
}

/// Dashed frame drawn in a ring just outside the area, excluded from screen capture so it
/// never shows in the video. While preparing, its ring and corners resize the area and the
/// handle in the middle moves it; the rest of the area stays click-through (on Windows, by
/// shaping the window, see `shape_frame`). Once recording starts, `lock_frame` freezes it.
fn open_frame(app: &AppHandle, area: Area) -> Result<(), String> {
    let scale =
        app.monitor_from_point(area.x as f64, area.y as f64).ok().flatten().map_or(1.0, |m| m.scale_factor());
    let m = (FRAME_MARGIN * scale).round() as i32;
    let frame = WebviewWindowBuilder::new(app, FRAME_LABEL, WebviewUrl::App("index.html".into()))
        .initialization_script(format!(
            "window.__SCREENCUP_RECFRAME__ = {{ width: {}, height: {}, margin: {FRAME_MARGIN}, corner: {FRAME_CORNER}, grip: {FRAME_GRIP} }};",
            area.width, area.height
        ))
        .title("Screencup area")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(true)
        .min_inner_size(2.0 * FRAME_CORNER + 16.0, 2.0 * FRAME_CORNER + 16.0)
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
    shape_frame(&frame, true);
    let handle = app.clone();
    frame.on_window_event(move |event| {
        let resized = matches!(event, tauri::WindowEvent::Resized(_));
        if !(resized || matches!(event, tauri::WindowEvent::Moved(_))) || !is_prepared(&handle) {
            return;
        }
        let Some(frame) = handle.get_webview_window(FRAME_LABEL) else { return };
        if resized {
            shape_frame(&frame, true);
        }
        if let Some(bar) = handle.get_webview_window(BAR_LABEL) {
            let _ = bar.set_position(bar_position(&handle, frame_area(&frame)));
        }
    });
    let _ = frame.show();
    Ok(())
}

/// The screen area inside the frame window's ring, in physical pixels.
fn frame_area(frame: &tauri::WebviewWindow) -> Area {
    let m = (FRAME_MARGIN * frame.scale_factor().unwrap_or(1.0)).round() as i32;
    let pos = frame.outer_position().unwrap_or_default();
    let size = frame.outer_size().unwrap_or_default();
    Area {
        x: pos.x + m,
        y: pos.y + m,
        width: (size.width as i32 - 2 * m).max(0) as u32,
        height: (size.height as i32 - 2 * m).max(0) as u32,
    }
}

/// yuv420p H.264 needs even dimensions.
fn even_area(a: Area) -> Area {
    Area { width: a.width & !1, height: a.height & !1, ..a }
}

/// Recording started: the frame snaps to the recorded (even-sized) area and stops reacting.
fn lock_frame(frame: &tauri::WebviewWindow, area: Area) {
    let m = (FRAME_MARGIN * frame.scale_factor().unwrap_or(1.0)).round() as i32;
    let _ = frame.set_resizable(false);
    let _ = frame.set_size(PhysicalSize::new(area.width + 2 * m as u32, area.height + 2 * m as u32));
    let _ = frame.set_ignore_cursor_events(true);
    shape_frame(frame, false);
}

/// Limits the frame window to the ring, the corner handles and (while `editable`) the move
/// handle, so clicks inside the area reach the windows below.
#[cfg(windows)]
fn shape_frame(frame: &tauri::WebviewWindow, editable: bool) {
    use windows_sys::Win32::Graphics::Gdi::{
        CombineRgn, CreateEllipticRgn, CreateRectRgn, DeleteObject, RGN_DIFF, RGN_OR, SetWindowRgn,
    };
    let Ok(hwnd) = frame.hwnd() else { return };
    let scale = frame.scale_factor().unwrap_or(1.0);
    let size = frame.outer_size().unwrap_or_default();
    let (w, h) = (size.width as i32, size.height as i32);
    let m = (FRAME_MARGIN * scale).round() as i32;
    let c = (FRAME_CORNER * scale).round() as i32;
    let g = (FRAME_GRIP * scale).round() as i32;
    let (lw, lh) = ((FRAME_LABEL_BOX.0 * scale).round() as i32, (FRAME_LABEL_BOX.1 * scale).round() as i32);
    // SAFETY: plain GDI region calls on regions created here; SetWindowRgn takes ownership of
    // `shape`, every other region is deleted.
    unsafe {
        let shape = CreateRectRgn(0, 0, w, h);
        let parts = [
            (CreateRectRgn(m, m, w - m, h - m), RGN_DIFF),
            (CreateRectRgn(0, 0, c, c), RGN_OR),
            (CreateRectRgn(w - c, 0, w, c), RGN_OR),
            (CreateRectRgn(0, h - c, c, h), RGN_OR),
            (CreateRectRgn(w - c, h - c, w, h), RGN_OR),
            (CreateRectRgn(w - m - lw, m, w - m, m + lh), RGN_OR),
        ];
        for (part, mode) in parts {
            CombineRgn(shape, shape, part, mode);
            DeleteObject(part);
        }
        if editable {
            let (cx, cy) = (w / 2, h / 2);
            let grip = CreateEllipticRgn(cx - g / 2, cy - g / 2, cx + g / 2 + 1, cy + g / 2 + 1);
            CombineRgn(shape, shape, grip, RGN_OR);
            DeleteObject(grip);
        }
        SetWindowRgn(hwnd.0 as _, shape, 1);
    }
}

/// Elsewhere the whole frame window takes the mouse while preparing.
#[cfg(not(windows))]
fn shape_frame(_frame: &tauri::WebviewWindow, _editable: bool) {}

fn close_windows(app: &AppHandle) {
    for label in [BAR_LABEL, FRAME_LABEL, crate::webcam::LABEL] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.destroy();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Joins two short clips made with the recorder's encoder settings. Needs ffmpeg
    /// (`SCREENCUP_FFMPEG` or PATH); skipped without it.
    #[test]
    fn concat_joins_segments() {
        let Ok(ffmpeg) = ffmpeg_exe() else { return };
        let dir = std::env::temp_dir().join(format!("screencup-concat-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let parts: Vec<PathBuf> = (0..2)
            .map(|i| {
                let part = dir.join(format!("part{i}.mp4"));
                let status = helper_command(&ffmpeg)
                    .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i"])
                    .arg("testsrc=size=320x240:rate=30:duration=1")
                    .args(["-f", "lavfi", "-i", "sine=frequency=440:duration=1"])
                    .args(encoder_args(&ffmpeg))
                    .args(["-c:a", "aac", "-shortest"])
                    .arg(&part)
                    .status()
                    .unwrap();
                assert!(status.success());
                part
            })
            .collect();
        let out = dir.join("joined.mp4");
        concat(&ffmpeg, &parts, &out, &dir.join("list.txt")).unwrap();
        let secs = media_seconds(&ffmpeg, &out).unwrap();
        assert!((1.8..2.3).contains(&secs), "joined length {secs}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
