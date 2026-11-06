//! Webcam overlay for screen recordings: a small round window with the camera image,
//! always on top inside the recorded area. Unlike the frame and the panel it is not
//! excluded from screen capture, so the video contains it. It opens with the recording
//! panel when enabled, can be dragged anywhere and resized with the mouse wheel, and closes
//! with the panel. The camera itself is read by the page (src/Webcam.tsx).

use tauri::{AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

use crate::capture::Area;

pub const LABEL: &str = "webcam";
/// Starting diameter, in logical pixels; the page resizes it with the wheel.
const SIZE: f64 = 200.0;
/// Distance from the bottom-right corner of the area, in logical pixels.
const INSET: f64 = 24.0;

/// Opens the overlay in the bottom-right corner of `area`, unless already open.
pub fn open(app: &AppHandle, area: Area) -> Result<(), String> {
    if app.get_webview_window(LABEL).is_some() {
        return Ok(());
    }
    let scale = app
        .monitor_from_point(area.x as f64 + area.width as f64 / 2.0, area.y as f64 + area.height as f64 / 2.0)
        .ok()
        .flatten()
        .map_or(1.0, |m| m.scale_factor());
    let (size, inset) = ((SIZE * scale) as i32, (INSET * scale) as i32);
    // Smaller areas get a smaller overlay, so it never covers most of the recording.
    let size = size.min(area.width as i32 / 3).min(area.height as i32 / 2).max((80.0 * scale) as i32);
    let x = area.x + area.width as i32 - size - inset;
    let y = area.y + area.height as i32 - size - inset;
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .initialization_script("window.__SCREENCUP_WEBCAM__ = true;")
        .title("Screencup webcam")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .inner_size(SIZE, SIZE)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = window.set_size(tauri::PhysicalSize::new(size as u32, size as u32));
    let _ = window.set_position(PhysicalPosition::new(x.max(area.x), y.max(area.y)));
    make_round(&window);
    let handle = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Resized(_) = event {
            make_round(&handle);
        }
    });
    let _ = window.show();
    Ok(())
}

/// Clips the window to a circle. The page rounds its own corners too, but the webview draws
/// the camera video on a layer that ignores that clipping; the window region does not.
#[cfg(windows)]
fn make_round(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::Graphics::Gdi::{CreateEllipticRgn, SetWindowRgn};
    let (Ok(hwnd), Ok(size)) = (window.hwnd(), window.outer_size()) else { return };
    // SAFETY: SetWindowRgn takes ownership of the region it is given.
    unsafe {
        let region = CreateEllipticRgn(0, 0, size.width as i32 + 1, size.height as i32 + 1);
        SetWindowRgn(hwnd.0 as _, region, 1);
    }
}

#[cfg(not(windows))]
fn make_round(_window: &tauri::WebviewWindow) {}

pub fn close(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.destroy();
    }
}

/// Webcam button of the recording panel: switches the overlay and remembers the choice.
/// Async: windows are built and destroyed here, which deadlocks in a synchronous command.
#[tauri::command]
pub async fn toggle_webcam(app: AppHandle) -> Result<bool, String> {
    let mut settings = crate::settings::load(&app);
    settings.record_webcam = !settings.record_webcam;
    let on = settings.record_webcam;
    crate::settings::set_settings(app.clone(), settings)?;
    if on {
        if let Some(area) = crate::recorder::current_area(&app) {
            open(&app, area)?;
        }
    } else {
        close(&app);
    }
    Ok(on)
}
