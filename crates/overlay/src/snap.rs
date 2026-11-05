//! Rectangles the selection can snap to, like an inspector: visible top-level windows in
//! z-order (topmost first), each with its visible child controls, in physical
//! virtual-desktop pixels. Collected right after the screen is frozen, so they describe the
//! frozen picture rather than whatever moves afterwards.

/// Half-open rectangle in physical virtual-desktop pixels.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Bounds {
    pub x0: i32,
    pub y0: i32,
    pub x1: i32,
    pub y1: i32,
}

impl Bounds {
    fn new(x0: i32, y0: i32, x1: i32, y1: i32) -> Option<Self> {
        (x1 > x0 && y1 > y0).then_some(Bounds { x0, y0, x1, y1 })
    }

    fn contains(&self, (x, y): (i32, i32)) -> bool {
        x >= self.x0 && x < self.x1 && y >= self.y0 && y < self.y1
    }

    fn area(&self) -> i64 {
        (self.x1 - self.x0) as i64 * (self.y1 - self.y0) as i64
    }

    pub fn intersect(&self, o: &Bounds) -> Option<Bounds> {
        Bounds::new(self.x0.max(o.x0), self.y0.max(o.y0), self.x1.min(o.x1), self.y1.min(o.y1))
    }
}

pub struct SnapWindow {
    frame: Bounds,
    /// Child controls, clipped to the frame.
    children: Vec<Bounds>,
}

/// The elements under `p`, outermost first: the frame of the topmost window there, then
/// its child controls containing the point, from largest to smallest. Depth 0 (the whole
/// window) is the default target; the overlay steps deeper with the mouse wheel, since in
/// apps like Explorer the panels cover the entire window and would hide it otherwise.
pub fn chain_at(windows: &[SnapWindow], p: (i32, i32)) -> Vec<Bounds> {
    let Some(w) = windows.iter().find(|w| w.frame.contains(p)) else { return Vec::new() };
    let mut inner: Vec<Bounds> = w.children.iter().filter(|c| c.contains(p)).copied().collect();
    inner.sort_by_key(|c| std::cmp::Reverse(c.area()));
    inner.dedup();
    std::iter::once(w.frame).chain(inner).collect()
}

#[cfg(windows)]
pub use win32::collect;

#[cfg(windows)]
mod win32 {
    use std::ffi::c_void;
    use std::mem::size_of;

    use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows_sys::Win32::Graphics::Dwm::{
        DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, EnumWindows, GWL_EXSTYLE, GetWindowLongW, GetWindowRect, IsIconic, IsWindowVisible,
        WS_EX_TRANSPARENT,
    };
    use windows_sys::core::BOOL;

    use super::{Bounds, SnapWindow};

    unsafe extern "system" fn push(hwnd: HWND, list: LPARAM) -> BOOL {
        // SAFETY: `list` is the `&mut Vec<HWND>` passed by `enumerate`, alive for the call.
        unsafe { (*(list as *mut Vec<HWND>)).push(hwnd) };
        1
    }

    /// Top-level windows (z-order, topmost first) or, with a parent, all its descendants.
    fn enumerate(parent: Option<HWND>) -> Vec<HWND> {
        let mut list: Vec<HWND> = Vec::new();
        let param = &mut list as *mut Vec<HWND> as LPARAM;
        // SAFETY: the callback only pushes into `list`, which outlives the synchronous call.
        unsafe {
            match parent {
                Some(p) => EnumChildWindows(p, Some(push), param),
                None => EnumWindows(Some(push), param),
            };
        }
        list
    }

    fn bounds(r: RECT) -> Option<Bounds> {
        Bounds::new(r.left, r.top, r.right, r.bottom)
    }

    fn window_rect(h: HWND) -> Option<Bounds> {
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        // SAFETY: `r` is a valid RECT out-parameter.
        (unsafe { GetWindowRect(h, &mut r) } != 0).then(|| bounds(r)).flatten()
    }

    /// The visible frame: without the invisible resize borders that Windows 10/11 count in
    /// `GetWindowRect` and that would make the highlight look 7 px too large.
    fn frame(h: HWND) -> Option<Bounds> {
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        // SAFETY: `r` is a RECT-sized out-parameter, as DWMWA_EXTENDED_FRAME_BOUNDS expects.
        let hr = unsafe {
            DwmGetWindowAttribute(
                h,
                DWMWA_EXTENDED_FRAME_BOUNDS as u32,
                &mut r as *mut RECT as *mut c_void,
                size_of::<RECT>() as u32,
            )
        };
        if hr == 0 { bounds(r) } else { window_rect(h) }
    }

    /// Windows that are visible to the window manager but not to the user: cloaked (e.g.
    /// suspended UWP apps, other virtual desktops) or click-through overlays.
    fn hidden(h: HWND) -> bool {
        let mut cloaked: u32 = 0;
        // SAFETY: `cloaked` is a u32 out-parameter, as DWMWA_CLOAKED expects.
        let hr = unsafe {
            DwmGetWindowAttribute(h, DWMWA_CLOAKED as u32, &mut cloaked as *mut u32 as *mut c_void, 4)
        };
        // SAFETY: plain queries on a window handle.
        let (visible, iconic, ex_style) =
            unsafe { (IsWindowVisible(h), IsIconic(h), GetWindowLongW(h, GWL_EXSTYLE)) };
        visible == 0 || iconic != 0 || (hr == 0 && cloaked != 0) || ex_style as u32 & WS_EX_TRANSPARENT != 0
    }

    pub fn collect() -> Vec<SnapWindow> {
        enumerate(None)
            .into_iter()
            .filter(|&h| !hidden(h))
            .filter_map(|h| {
                let frame = frame(h)?;
                let children = enumerate(Some(h))
                    .into_iter()
                    // SAFETY: plain query on a window handle.
                    .filter(|&c| unsafe { IsWindowVisible(c) } != 0)
                    .filter_map(window_rect)
                    .filter_map(|b| b.intersect(&frame))
                    .filter(|b| *b != frame)
                    .collect();
                Some(SnapWindow { frame, children })
            })
            .collect()
    }
}

/// Elsewhere only top-level windows are known (no child controls), via xcap.
#[cfg(not(windows))]
pub fn collect() -> Vec<SnapWindow> {
    let Ok(windows) = xcap::Window::all() else { return Vec::new() };
    let mut found: Vec<(i32, SnapWindow)> = windows
        .iter()
        .filter(|w| !w.is_minimized().unwrap_or(true))
        .filter_map(|w| {
            let (x, y) = (w.x().ok()?, w.y().ok()?);
            let (wd, ht) = (w.width().ok()? as i32, w.height().ok()? as i32);
            let frame = Bounds::new(x, y, x + wd, y + ht)?;
            Some((w.z().unwrap_or(0), SnapWindow { frame, children: Vec::new() }))
        })
        .collect();
    // Higher z is closer to the viewer.
    found.sort_by_key(|(z, _)| std::cmp::Reverse(*z));
    found.into_iter().map(|(_, w)| w).collect()
}
