//! Frozen-screen region selector.
//!
//! Captures every monitor *before* anything is shown, then covers each monitor with a
//! borderless topmost window that paints the frozen capture. The user drags a rectangle and
//! the crop is cut from the original capture in physical pixels, so the saved image is exactly
//! what was on screen when the overlay was invoked, whatever happens underneath meanwhile.
//!
//! Usage:
//!   screencup-overlay [--out FILE.png]   select a region, save it, print a JSON result on stdout
//!   screencup-overlay --dump DIR         capture only (no UI), save one PNG per monitor
//!
//! Exit codes: 0 = saved, 1 = cancelled, 2 = error.

use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use softbuffer::{Context, Surface};
use winit::application::ApplicationHandler;
use winit::dpi::PhysicalSize;
use winit::event::{ElementState, MouseButton, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::keyboard::{Key, NamedKey};
use winit::monitor::MonitorHandle;
use winit::window::{CursorIcon, Window, WindowId, WindowLevel};
use xcap::image::{RgbaImage, imageops};

const ACCENT: u32 = 0x2D8CFF;
const WHITE: u32 = 0xFFFFFF;
/// Source pixels shown by the magnifier per side (odd, so there is a centre pixel).
const MAG_SRC: i32 = 17;
const MAG_ZOOM: i32 = 7;
const MAG_GAP: i32 = 20;

/// One monitor's frozen capture, positioned in virtual-desktop coordinates.
struct Shot {
    img: RgbaImage,
    x: i32,
    y: i32,
}

fn capture_all() -> Result<Vec<Shot>, String> {
    let err = |e: xcap::XCapError| e.to_string();
    xcap::Monitor::all()
        .map_err(err)?
        .iter()
        .map(|m| {
            Ok(Shot { img: m.capture_image().map_err(err)?, x: m.x().map_err(err)?, y: m.y().map_err(err)? })
        })
        .collect()
}

/// Half-open rectangle in window pixels.
#[derive(Clone, Copy)]
struct Rect {
    x0: i32,
    y0: i32,
    x1: i32,
    y1: i32,
}

impl Rect {
    fn from_points(a: (i32, i32), b: (i32, i32)) -> Self {
        Rect { x0: a.0.min(b.0), y0: a.1.min(b.1), x1: a.0.max(b.0), y1: a.1.max(b.1) }
    }
    fn width(&self) -> i32 {
        self.x1 - self.x0
    }
    fn height(&self) -> i32 {
        self.y1 - self.y0
    }
}

/// A software framebuffer with clipped drawing primitives.
struct Canvas<'a> {
    buf: &'a mut [u32],
    w: i32,
    h: i32,
}

impl Canvas<'_> {
    fn fill(&mut self, x0: i32, y0: i32, x1: i32, y1: i32, c: u32) {
        let (x0, x1) = (x0.clamp(0, self.w), x1.clamp(0, self.w));
        let (y0, y1) = (y0.clamp(0, self.h), y1.clamp(0, self.h));
        if x0 >= x1 {
            return;
        }
        for y in y0..y1 {
            let row = (y * self.w) as usize;
            self.buf[row + x0 as usize..row + x1 as usize].fill(c);
        }
    }

    /// 1px outline drawn just outside `r`.
    fn outline(&mut self, r: Rect, c: u32) {
        self.fill(r.x0 - 1, r.y0 - 1, r.x1 + 1, r.y0, c);
        self.fill(r.x0 - 1, r.y1, r.x1 + 1, r.y1 + 1, c);
        self.fill(r.x0 - 1, r.y0, r.x0, r.y1, c);
        self.fill(r.x1, r.y0, r.x1 + 1, r.y1, c);
    }
}

/// Converts the capture to 0RGB at the window size, plus a dimmed copy for the backdrop.
/// The sizes normally match; nearest sampling only covers DPI/size mismatches.
fn prepare(img: &RgbaImage, w: u32, h: u32) -> (Vec<u32>, Vec<u32>) {
    let (iw, ih) = img.dimensions();
    let raw = img.as_raw();
    let mut bright = Vec::with_capacity((w * h) as usize);
    for y in 0..h {
        let sy = (y as u64 * ih as u64 / h as u64) as u32;
        for x in 0..w {
            let sx = (x as u64 * iw as u64 / w as u64) as u32;
            let i = ((sy * iw + sx) * 4) as usize;
            bright.push((raw[i] as u32) << 16 | (raw[i + 1] as u32) << 8 | raw[i + 2] as u32);
        }
    }
    let dim = bright.iter().map(|p| (p >> 1) & 0x7F7F7F).collect();
    (bright, dim)
}

struct Overlay {
    window: Arc<Window>,
    surface: Surface<Arc<Window>, Arc<Window>>,
    shot: usize,
    size: (u32, u32),
    bright: Vec<u32>,
    dim: Vec<u32>,
    cursor: Option<(i32, i32)>,
}

impl Overlay {
    fn draw(&mut self, shot: &Shot, selection: Option<Rect>) {
        let PhysicalSize { width, height } = self.window.inner_size();
        let (Some(nw), Some(nh)) = (NonZeroU32::new(width), NonZeroU32::new(height)) else {
            return;
        };
        if self.size != (width, height) {
            (self.bright, self.dim) = prepare(&shot.img, width, height);
            self.surface.resize(nw, nh).expect("resize surface");
            self.size = (width, height);
        }
        let mut buf = self.surface.buffer_mut().expect("surface buffer");
        buf.copy_from_slice(&self.dim);
        let (w, h) = (width as i32, height as i32);
        let mut cv = Canvas { buf: &mut buf, w, h };

        match (selection, self.cursor) {
            (Some(r), _) => {
                for y in r.y0..r.y1 {
                    let row = (y * w) as usize;
                    let span = row + r.x0 as usize..row + r.x1 as usize;
                    cv.buf[span.clone()].copy_from_slice(&self.bright[span]);
                }
                cv.outline(r, ACCENT);
            }
            (None, Some((cx, cy))) => {
                cv.fill(0, cy, w, cy + 1, ACCENT);
                cv.fill(cx, 0, cx + 1, h, ACCENT);
            }
            (None, None) => {}
        }

        if let Some((cx, cy)) = self.cursor {
            let side = MAG_SRC * MAG_ZOOM;
            let mx = if cx + MAG_GAP + side + 2 > w { cx - MAG_GAP - side } else { cx + MAG_GAP };
            let my = if cy + MAG_GAP + side + 2 > h { cy - MAG_GAP - side } else { cy + MAG_GAP };
            for j in 0..MAG_SRC {
                for i in 0..MAG_SRC {
                    let (sx, sy) = (cx - MAG_SRC / 2 + i, cy - MAG_SRC / 2 + j);
                    let c = if (0..w).contains(&sx) && (0..h).contains(&sy) {
                        self.bright[(sy * w + sx) as usize]
                    } else {
                        0
                    };
                    let (bx, by) = (mx + i * MAG_ZOOM, my + j * MAG_ZOOM);
                    cv.fill(bx, by, bx + MAG_ZOOM, by + MAG_ZOOM, c);
                }
            }
            let centre = mx + (MAG_SRC / 2) * MAG_ZOOM;
            let middle = my + (MAG_SRC / 2) * MAG_ZOOM;
            cv.outline(Rect { x0: centre, y0: middle, x1: centre + MAG_ZOOM, y1: middle + MAG_ZOOM }, ACCENT);
            cv.outline(Rect { x0: mx, y0: my, x1: mx + side, y1: my + side }, WHITE);
        }

        buf.present().expect("present");
    }
}

struct Drag {
    window: WindowId,
    start: (i32, i32),
    end: (i32, i32),
}

struct App {
    shots: Vec<Shot>,
    out: PathBuf,
    overlays: Vec<Overlay>,
    drag: Option<Drag>,
    /// `None` when the user cancelled.
    result: Option<Result<String, String>>,
    t0: Instant,
}

impl App {
    fn selection_for(&self, id: WindowId) -> Option<Rect> {
        self.drag.as_ref().filter(|d| d.window == id).map(|d| Rect::from_points(d.start, d.end))
    }

    fn finish(&mut self, event_loop: &ActiveEventLoop, idx: usize, r: Rect) {
        for o in &self.overlays {
            o.window.set_visible(false);
        }
        let shot = &self.shots[self.overlays[idx].shot];
        let (w, h) = self.overlays[idx].size;
        let (iw, ih) = shot.img.dimensions();
        let sx = |x: i32| (x as u64 * iw as u64 / w as u64) as u32;
        let sy = |y: i32| (y as u64 * ih as u64 / h as u64) as u32;
        let (ix0, iy0, ix1, iy1) = (sx(r.x0), sy(r.y0), sx(r.x1), sy(r.y1));
        let crop = imageops::crop_imm(&shot.img, ix0, iy0, ix1 - ix0, iy1 - iy0).to_image();
        self.result = Some(save(&crop, &self.out).map(|()| {
            serde_json::json!({
                "path": self.out,
                "monitor": self.overlays[idx].shot,
                "rect": {
                    "x": shot.x + ix0 as i32,
                    "y": shot.y + iy0 as i32,
                    "width": ix1 - ix0,
                    "height": iy1 - iy0,
                },
                "elapsed_ms": self.t0.elapsed().as_millis() as u64,
            })
            .to_string()
        }));
        event_loop.exit();
    }
}

fn save(img: &RgbaImage, path: &Path) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    img.save(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Pairs a capture with the winit monitor at (or nearest to) the same origin.
fn monitor_for(shot: &Shot, monitors: &[MonitorHandle]) -> Option<MonitorHandle> {
    monitors
        .iter()
        .min_by_key(|m| {
            let p = m.position();
            (p.x - shot.x).abs() + (p.y - shot.y).abs()
        })
        .cloned()
}

impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if !self.overlays.is_empty() {
            return;
        }
        let monitors: Vec<MonitorHandle> = event_loop.available_monitors().collect();
        for (i, shot) in self.shots.iter().enumerate() {
            let Some(mon) = monitor_for(shot, &monitors) else { continue };
            let mut attrs = Window::default_attributes()
                .with_title("Screencup")
                .with_decorations(false)
                .with_resizable(false)
                .with_visible(false)
                .with_window_level(WindowLevel::AlwaysOnTop)
                .with_position(mon.position())
                .with_inner_size(mon.size());
            // macOS borderless fullscreen opens a new Space with an animation; there the
            // positioned, undecorated, always-on-top window is used as is.
            #[cfg(not(target_os = "macos"))]
            {
                use winit::window::Fullscreen;
                attrs = attrs.with_fullscreen(Some(Fullscreen::Borderless(Some(mon.clone()))));
            }
            #[cfg(target_os = "windows")]
            {
                use winit::platform::windows::WindowAttributesExtWindows;
                attrs = attrs.with_skip_taskbar(true);
            }
            let window = Arc::new(event_loop.create_window(attrs).expect("create overlay window"));
            window.set_cursor(CursorIcon::Crosshair);
            let context = Context::new(window.clone()).expect("softbuffer context");
            let surface = Surface::new(&context, window.clone()).expect("softbuffer surface");
            let mut o = Overlay {
                window,
                surface,
                shot: i,
                size: (0, 0),
                bright: Vec::new(),
                dim: Vec::new(),
                cursor: None,
            };
            // Windows never sends a paint to a hidden window, so show first and paint right
            // away. The window class has no background brush, so until the paint lands the
            // screen behind shows through, which already looks like the frozen frame.
            o.window.set_visible(true);
            o.draw(shot, None);
            o.window.focus_window();
            eprintln!("monitor {i} shown at {} ms", self.t0.elapsed().as_millis());
            self.overlays.push(o);
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, id: WindowId, event: WindowEvent) {
        let Some(idx) = self.overlays.iter().position(|o| o.window.id() == id) else { return };
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::RedrawRequested => {
                let selection = self.selection_for(id);
                let o = &mut self.overlays[idx];
                o.draw(&self.shots[o.shot], selection);
            }
            WindowEvent::CursorMoved { position, .. } => {
                let o = &mut self.overlays[idx];
                let (w, h) = (o.size.0 as i32, o.size.1 as i32);
                let p = (position.x as i32, position.y as i32);
                o.cursor = Some(p);
                if let Some(d) = self.drag.as_mut().filter(|d| d.window == id) {
                    d.end = (p.0.clamp(0, w), p.1.clamp(0, h));
                }
                o.window.request_redraw();
            }
            WindowEvent::CursorLeft { .. } => {
                let o = &mut self.overlays[idx];
                o.cursor = None;
                o.window.request_redraw();
            }
            WindowEvent::MouseInput { state, button, .. } => match (button, state) {
                (MouseButton::Left, ElementState::Pressed) => {
                    if let Some(p) = self.overlays[idx].cursor {
                        self.drag = Some(Drag { window: id, start: p, end: p });
                    }
                }
                (MouseButton::Left, ElementState::Released) => {
                    if let Some(r) = self.selection_for(id) {
                        if r.width() >= 2 && r.height() >= 2 {
                            return self.finish(event_loop, idx, r);
                        }
                        self.drag = None;
                    }
                    self.overlays[idx].window.request_redraw();
                }
                (MouseButton::Right, ElementState::Pressed) => {
                    // First right-click drops the selection, a second one cancels.
                    if self.drag.take().is_none() {
                        event_loop.exit();
                    }
                    self.overlays[idx].window.request_redraw();
                }
                _ => {}
            },
            WindowEvent::KeyboardInput { event, .. }
                if event.state == ElementState::Pressed
                    && event.logical_key == Key::Named(NamedKey::Escape) =>
            {
                event_loop.exit()
            }
            _ => {}
        }
    }
}

fn default_out() -> PathBuf {
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis());
    std::env::temp_dir().join("screencup").join(format!("capture-{ms}.png"))
}

fn main() -> ExitCode {
    let t0 = Instant::now();
    let mut out = None;
    let mut dump = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--out" => out = args.next().map(PathBuf::from),
            "--dump" => dump = args.next().map(PathBuf::from),
            other => {
                eprintln!("unknown argument: {other}");
                return ExitCode::from(2);
            }
        }
    }

    // Created before capturing: on Windows this makes the process per-monitor DPI aware,
    // so captures come back in physical pixels.
    let event_loop = match EventLoop::new() {
        Ok(el) => el,
        Err(e) => {
            eprintln!("event loop: {e}");
            return ExitCode::from(2);
        }
    };
    let shots = match capture_all() {
        Ok(s) if !s.is_empty() => s,
        Ok(_) => {
            eprintln!("no monitors found");
            return ExitCode::from(2);
        }
        Err(e) => {
            eprintln!("capture failed: {e}");
            return ExitCode::from(2);
        }
    };
    eprintln!("captured {} monitor(s) in {} ms", shots.len(), t0.elapsed().as_millis());

    if let Some(dir) = dump {
        for (i, s) in shots.iter().enumerate() {
            let path = dir.join(format!("monitor-{i}.png"));
            if let Err(e) = save(&s.img, &path) {
                eprintln!("{e}");
                return ExitCode::from(2);
            }
            println!("{} at ({}, {}) {}x{}", path.display(), s.x, s.y, s.img.width(), s.img.height());
        }
        return ExitCode::SUCCESS;
    }

    let mut app = App {
        shots,
        out: out.unwrap_or_else(default_out),
        overlays: Vec::new(),
        drag: None,
        result: None,
        t0,
    };
    if let Err(e) = event_loop.run_app(&mut app) {
        eprintln!("event loop: {e}");
        return ExitCode::from(2);
    }
    match app.result {
        Some(Ok(json)) => {
            println!("{json}");
            ExitCode::SUCCESS
        }
        Some(Err(e)) => {
            eprintln!("save failed: {e}");
            ExitCode::from(2)
        }
        None => ExitCode::from(1),
    }
}
