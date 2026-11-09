//! Language of the UI. `language` in the settings is "auto" (follow the system locale) or a
//! language code. The frontend has its own dictionaries (src/locales) and asks for the
//! resolved language with `get_language`; the few texts drawn by the backend (tray menu,
//! window titles, dialogs) come from `text` below.

use serde::Serialize;
use tauri::{AppHandle, Runtime};

/// Keep in sync with `Lang` in src/i18n.ts. The order is the column order of `TEXTS`.
#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Lang {
    It,
    En,
    Es,
    Fr,
    De,
    Pt,
}

impl Lang {
    fn from_code(code: &str) -> Option<Lang> {
        let code = code.to_ascii_lowercase();
        Some(match code.get(..2)? {
            "it" => Lang::It,
            "en" => Lang::En,
            "es" => Lang::Es,
            "fr" => Lang::Fr,
            "de" => Lang::De,
            "pt" => Lang::Pt,
            _ => return None,
        })
    }
}

/// The language to use now: the one picked in the settings, else the system's when it is
/// supported, else English.
pub fn lang<R: Runtime>(app: &AppHandle<R>) -> Lang {
    let picked = crate::settings::load(app).language;
    Lang::from_code(&picked)
        .or_else(|| sys_locale::get_locale().and_then(|l| Lang::from_code(&l)))
        .unwrap_or(Lang::En)
}

#[tauri::command]
pub fn get_language(app: AppHandle) -> Lang {
    lang(&app)
}

/// Backend texts: key, then it, en, es, fr, de, pt.
const TEXTS: &[(&str, [&str; 6])] = &[
    (
        "capture-region",
        [
            "Cattura una regione",
            "Capture a region",
            "Capturar una región",
            "Capturer une zone",
            "Bereich aufnehmen",
            "Capturar uma região",
        ],
    ),
    (
        "capture-screen",
        [
            "Cattura lo schermo",
            "Capture the screen",
            "Capturar la pantalla",
            "Capturer l'écran",
            "Bildschirm aufnehmen",
            "Capturar a tela",
        ],
    ),
    (
        "capture-all",
        [
            "Cattura tutti gli schermi",
            "Capture all screens",
            "Capturar todas las pantallas",
            "Capturer tous les écrans",
            "Alle Bildschirme aufnehmen",
            "Capturar todas as telas",
        ],
    ),
    (
        "record-region",
        [
            "Registra una regione",
            "Record a region",
            "Grabar una región",
            "Enregistrer une zone",
            "Bereich aufzeichnen",
            "Gravar uma região",
        ],
    ),
    (
        "record-screen",
        [
            "Registra lo schermo",
            "Record the screen",
            "Grabar la pantalla",
            "Enregistrer l'écran",
            "Bildschirm aufzeichnen",
            "Gravar a tela",
        ],
    ),
    (
        "record-stop",
        [
            "Ferma la registrazione",
            "Stop recording",
            "Detener la grabación",
            "Arrêter l'enregistrement",
            "Aufzeichnung stoppen",
            "Parar a gravação",
        ],
    ),
    (
        "check-updates",
        [
            "Verifica aggiornamenti...",
            "Check for updates...",
            "Buscar actualizaciones...",
            "Rechercher des mises à jour...",
            "Nach Updates suchen...",
            "Verificar atualizações...",
        ],
    ),
    (
        "update-tooltip",
        [
            "aggiornamento {version} disponibile",
            "update {version} available",
            "actualización {version} disponible",
            "mise à jour {version} disponible",
            "Update {version} verfügbar",
            "atualização {version} disponível",
        ],
    ),
    ("pick-color", ["Contagocce", "Color picker", "Cuentagotas", "Pipette", "Farbpipette", "Conta-gotas"]),
    (
        "open-gallery",
        [
            "Apri la galleria",
            "Open the gallery",
            "Abrir la galería",
            "Ouvrir la galerie",
            "Galerie öffnen",
            "Abrir a galeria",
        ],
    ),
    (
        "settings-menu",
        [
            "Impostazioni...",
            "Settings...",
            "Ajustes...",
            "Paramètres...",
            "Einstellungen...",
            "Configurações...",
        ],
    ),
    (
        "about",
        [
            "Informazioni su Screencup",
            "About Screencup",
            "Acerca de Screencup",
            "À propos de Screencup",
            "Über Screencup",
            "Sobre o Screencup",
        ],
    ),
    (
        "quit",
        [
            "Esci da Screencup",
            "Quit Screencup",
            "Salir de Screencup",
            "Quitter Screencup",
            "Screencup beenden",
            "Sair do Screencup",
        ],
    ),
    (
        "settings-title",
        [
            "Impostazioni di Screencup",
            "Screencup settings",
            "Ajustes de Screencup",
            "Paramètres de Screencup",
            "Screencup-Einstellungen",
            "Configurações do Screencup",
        ],
    ),
    (
        "library-folder",
        [
            "Cartella delle catture",
            "Captures folder",
            "Carpeta de capturas",
            "Dossier des captures",
            "Ordner für Aufnahmen",
            "Pasta das capturas",
        ],
    ),
    (
        "licenses-missing",
        [
            "cartella delle licenze non trovata",
            "licences folder not found",
            "no se encontró la carpeta de licencias",
            "dossier des licences introuvable",
            "Lizenzordner nicht gefunden",
            "pasta de licenças não encontrada",
        ],
    ),
];

/// The backend text for `key` in the current language; the key itself when unknown.
pub fn text<R: Runtime>(app: &AppHandle<R>, key: &'static str) -> &'static str {
    let column = lang(app) as usize;
    TEXTS.iter().find(|(k, _)| *k == key).map_or(key, |(_, texts)| texts[column])
}
