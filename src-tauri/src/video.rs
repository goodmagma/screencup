//! Video editing: trimming the start and end of a recording, and exporting a stretch of it
//! as an animated GIF. Both run ffmpeg; the video editor window plays the file through the
//! asset protocol.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt as _;

use crate::capture::helper_command;
use crate::{library, recorder};

/// Widths offered for GIFs; 0 keeps the recording's width. Keep in sync with
/// `GIF_WIDTHS` in src/VideoEditor.tsx.
const GIF_WIDTHS: [u32; 5] = [0, 1280, 960, 640, 480];
const GIF_FRAMERATES: [u32; 3] = [10, 15, 20];

fn video_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let path = library::resolve(app, name)?;
    if !library::is_video(&path) {
        return Err(format!("{name}: not a video"));
    }
    Ok(path)
}

/// Path of a recording for the player; the file is allowed through the asset protocol.
#[tauri::command]
pub fn video_source(app: AppHandle, name: String) -> Result<PathBuf, String> {
    let path = video_path(&app, &name)?;
    app.asset_protocol_scope().allow_file(&path).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Opens the video editor for a recording, or focuses it. Async: building a window from a
/// synchronous command deadlocks on Windows.
#[tauri::command]
pub async fn open_video_editor(app: AppHandle, name: String) -> Result<(), String> {
    video_path(&app, &name)?;
    let label: String = format!("video-{name}")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
        .collect();
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.unminimize();
        return w.set_focus().map_err(|e| e.to_string());
    }
    let init =
        format!("window.__SCREENCUP_VIDEO__ = {};", serde_json::to_string(&name).map_err(|e| e.to_string())?);
    WebviewWindowBuilder::new(&app, label, WebviewUrl::App("index.html".into()))
        .initialization_script(&init)
        .title(format!("Screencup video - {name}"))
        .icon(crate::small_icon())
        .map_err(|e| e.to_string())?
        .inner_size(1100.0, 760.0)
        .min_inner_size(700.0, 480.0)
        .center()
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn run(cmd: &mut std::process::Command) -> Result<(), String> {
    let output = cmd.output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr)
            .trim()
            .lines()
            .last()
            .unwrap_or("ffmpeg failed")
            .to_owned())
    }
}

fn check_range(start: f64, end: f64) -> Result<(), String> {
    if !(start.is_finite() && end.is_finite() && start >= 0.0 && end - start >= 0.1) {
        return Err(format!("invalid range {start:.2}-{end:.2}"));
    }
    Ok(())
}

/// Keeps `start..end` seconds of the recording. The cut is re-encoded so it falls on the
/// exact frames; the previous file goes to the trash.
#[tauri::command]
pub async fn trim_video(app: AppHandle, name: String, start: f64, end: f64) -> Result<(), String> {
    check_range(start, end)?;
    let src = video_path(&app, &name)?;
    let ffmpeg = recorder::ffmpeg_exe()?;
    let work = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("recording");
    std::fs::create_dir_all(&work).map_err(|e| format!("{}: {e}", work.display()))?;
    let tmp = work.join(format!("trim-{name}"));
    let encoder = recorder::encoder_args(&ffmpeg);
    let result = tauri::async_runtime::spawn_blocking({
        let (src, tmp, ffmpeg) = (src.clone(), tmp.clone(), ffmpeg.clone());
        move || {
            run(helper_command(&ffmpeg)
                .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
                .arg(&src)
                .args(["-ss", &format!("{start:.3}"), "-to", &format!("{end:.3}")])
                .args(encoder)
                .args(["-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"])
                .arg(&tmp))
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    trash::delete(&src).map_err(|e| e.to_string())?;
    move_file(&tmp, &src)?;
    library::forget_thumbnail(&app, &name);
    let _ = app.emit("capture-updated", &name);
    Ok(())
}

fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::rename(from, to)
        .or_else(|_| std::fs::copy(from, to).and_then(|_| std::fs::remove_file(from)))
        .map_err(|e| format!("{}: {e}", to.display()))
}

/// Saves `start..end` seconds as an animated GIF where the user picks. `width` 0 keeps the
/// recording's width. Returns the path, or `None` when the dialog was dismissed.
#[tauri::command]
pub async fn export_gif(
    app: AppHandle,
    name: String,
    start: f64,
    end: f64,
    width: u32,
    fps: u32,
) -> Result<Option<PathBuf>, String> {
    check_range(start, end)?;
    if !GIF_WIDTHS.contains(&width) || !GIF_FRAMERATES.contains(&fps) {
        return Err(format!("unsupported GIF settings {width}px {fps}fps"));
    }
    let src = video_path(&app, &name)?;
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let Some(dest) = app
        .dialog()
        .file()
        .set_file_name(format!("{stem}.gif"))
        .add_filter("GIF", &["gif"])
        .blocking_save_file()
        .and_then(|p| p.into_path().ok())
    else {
        return Ok(None);
    };
    let ffmpeg = recorder::ffmpeg_exe()?;
    // One pass: a palette built from the clip itself keeps the colours of a screen recording.
    let scale = if width == 0 { String::new() } else { format!(",scale={width}:-1:flags=lanczos") };
    let graph = format!(
        "fps={fps}{scale},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4"
    );
    let out = dest.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run(helper_command(&ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-y"])
            .args(["-ss", &format!("{start:.3}"), "-to", &format!("{end:.3}"), "-i"])
            .arg(&src)
            .args(["-filter_complex", &graph, "-loop", "0"])
            .arg(&out))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Some(dest))
}
