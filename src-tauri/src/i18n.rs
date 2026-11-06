//! Language of the UI. `language` in the settings is "auto" (follow the system locale),
//! "it" or "en". The frontend has its own dictionaries (src/i18n.ts) and asks for the
//! resolved language with `get_language`; the few texts drawn by the backend (tray menu,
//! window titles, dialogs) come from `text` below.

use serde::Serialize;
use tauri::{AppHandle, Runtime};

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Lang {
    It,
    En,
}

/// The language to use now: the one picked in the settings, else the system's when it is
/// Italian, else English.
pub fn lang<R: Runtime>(app: &AppHandle<R>) -> Lang {
    match crate::settings::load(app).language.as_str() {
        "it" => Lang::It,
        "en" => Lang::En,
        _ => system(),
    }
}

fn system() -> Lang {
    match sys_locale::get_locale() {
        Some(l) if l.to_ascii_lowercase().starts_with("it") => Lang::It,
        _ => Lang::En,
    }
}

#[tauri::command]
pub fn get_language(app: AppHandle) -> Lang {
    lang(&app)
}

/// Backend texts, in the order Italian, English.
pub fn text<R: Runtime>(app: &AppHandle<R>, it: &'static str, en: &'static str) -> &'static str {
    match lang(app) {
        Lang::It => it,
        Lang::En => en,
    }
}
