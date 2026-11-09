//! Global shortcuts, configured in the settings. Each registered shortcut id maps to the
//! action it triggers, so the handler does not depend on which keys were chosen.

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

use crate::capture::{self, CaptureKind};
use crate::recorder::{self, RecordKind};
use crate::settings::Hotkeys;

#[derive(Clone, Copy)]
enum Action {
    Capture(CaptureKind),
    Record(RecordKind),
}

/// Registered shortcut id -> action.
#[derive(Default)]
pub struct Bindings(Mutex<HashMap<u32, Action>>);

/// Replaces every registered shortcut with `keys`; returns one message per failure.
pub fn apply(app: &AppHandle, keys: &Hotkeys) -> Vec<String> {
    clear(app);
    let tr = |key| crate::i18n::text(app, key);
    let wanted = [
        (tr("capture-region"), &keys.capture_region, Action::Capture(CaptureKind::Region)),
        (tr("capture-screen"), &keys.capture_screen, Action::Capture(CaptureKind::Screen)),
        (tr("capture-all"), &keys.capture_all, Action::Capture(CaptureKind::All)),
        (tr("record-region"), &keys.record_region, Action::Record(RecordKind::Region)),
        (tr("record-screen"), &keys.record_screen, Action::Record(RecordKind::Screen)),
        (tr("pick-color"), &keys.pick_color, Action::Capture(CaptureKind::Color)),
    ];
    let mut failures = Vec::new();
    let mut bound = HashMap::new();
    for (label, accelerator, action) in wanted {
        if accelerator.trim().is_empty() {
            continue;
        }
        let result = Shortcut::from_str(accelerator)
            .map_err(|e| e.to_string())
            .and_then(|s| app.global_shortcut().register(s).map(|()| s).map_err(|e| e.to_string()));
        match result {
            Ok(s) => {
                bound.insert(s.id(), action);
            }
            Err(e) => failures.push(format!("{label} ({accelerator}): {e}")),
        }
    }
    if let Ok(mut map) = app.state::<Bindings>().0.lock() {
        *map = bound;
    }
    for f in &failures {
        eprintln!("hotkey not registered: {f}");
    }
    failures
}

pub fn clear(app: &AppHandle) {
    let _ = app.global_shortcut().unregister_all();
    if let Ok(mut map) = app.state::<Bindings>().0.lock() {
        map.clear();
    }
}

/// Called by the global-shortcut plugin on key press.
pub fn trigger(app: &AppHandle, shortcut: &Shortcut) {
    let action = app.state::<Bindings>().0.lock().ok().and_then(|m| m.get(&shortcut.id()).copied());
    match action {
        Some(Action::Capture(kind)) => capture::capture(app.clone(), kind),
        Some(Action::Record(kind)) => recorder::toggle(app.clone(), kind),
        None => {}
    }
}
