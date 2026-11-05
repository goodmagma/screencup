//! Mouse click highlights in screen recordings.
//!
//! A transparent, click-through, always-on-top window covers the recorded area; a watcher
//! thread reports every mouse press inside it, and the page (src/ClickFx.tsx) draws a short
//! ripple there. ffmpeg grabs the screen as it is, so the ripples end up in the video with
//! no extra encoding pass. Click detection is Windows-only for now.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;

use serde::Serialize;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

use crate::capture::Area;

const LABEL: &str = "clickfx";
/// Event the effect window listens to.
const EVENT: &str = "click-fx";

/// A press, in physical pixels relative to the top-left of the recorded area.
#[derive(Clone, Serialize)]
struct Click {
    x: i32,
    y: i32,
    /// "left" or "right".
    button: &'static str,
}

pub struct ClickFx {
    stop: Arc<AtomicBool>,
    watcher: Option<JoinHandle<()>>,
}

impl ClickFx {
    pub fn start(app: &AppHandle, area: Area) -> Result<Self, String> {
        let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
            .initialization_script("window.__SCREENCUP_CLICKFX__ = true;")
            .title("Screencup clicks")
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focusable(false)
            .focused(false)
            .visible(false)
            .build()
            .map_err(|e| e.to_string())?;
        let _ = window.set_position(PhysicalPosition::new(area.x, area.y));
        let _ = window.set_size(PhysicalSize::new(area.width, area.height));
        // Clicks go through to the windows being recorded.
        let _ = window.set_ignore_cursor_events(true);
        let _ = window.show();

        let stop = Arc::new(AtomicBool::new(false));
        let watcher = {
            let (app, stop) = (app.clone(), stop.clone());
            std::thread::spawn(move || watch(&app, area, &stop))
        };
        Ok(ClickFx { stop, watcher: Some(watcher) })
    }

    pub fn finish(mut self, app: &AppHandle) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.watcher.take() {
            let _ = t.join();
        }
        if let Some(w) = app.get_webview_window(LABEL) {
            let _ = w.destroy();
        }
    }
}

/// Polls the mouse buttons and reports each new press inside `area`.
#[cfg(windows)]
fn watch(app: &AppHandle, area: Area, stop: &AtomicBool) {
    use std::time::Duration;

    use tauri::Emitter;
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    /// Short enough not to miss a quick click, cheap enough to run for hours.
    const POLL: Duration = Duration::from_millis(8);
    let buttons = [(VK_LBUTTON, "left"), (VK_RBUTTON, "right")];
    let mut was_down = [false; 2];
    while !stop.load(Ordering::SeqCst) {
        for (i, (key, button)) in buttons.iter().enumerate() {
            // SAFETY: plain state query; the high bit means "currently down".
            let down = unsafe { GetAsyncKeyState(*key as i32) } as u16 & 0x8000 != 0;
            if down && !was_down[i] {
                let mut p = POINT { x: 0, y: 0 };
                // SAFETY: `p` is a valid POINT out-parameter. The process is per-monitor DPI
                // aware, so this is in physical pixels like `area`.
                if unsafe { GetCursorPos(&mut p) } != 0 {
                    let (x, y) = (p.x - area.x, p.y - area.y);
                    if (0..area.width as i32).contains(&x) && (0..area.height as i32).contains(&y) {
                        let _ = app.emit_to(LABEL, EVENT, Click { x, y, button });
                    }
                }
            }
            was_down[i] = down;
        }
        std::thread::sleep(POLL);
    }
}

#[cfg(not(windows))]
fn watch(_app: &AppHandle, _area: Area, _stop: &AtomicBool) {}
