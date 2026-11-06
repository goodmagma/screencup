/**
 * UI translations. The language is resolved by the backend (`get_language` in
 * src-tauri/src/i18n.rs) from the settings, or from the system locale when set to
 * automatic, and loaded once per window before the first render (see main.tsx).
 *
 * `{name}` placeholders are filled from the `params` of `t`.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const it = {
  // common
  "common.cancel": "Annulla",
  "common.close": "Chiudi",
  "common.delete": "Elimina",
  "common.settings": "Impostazioni",
  "common.microphone": "Microfono",
  "common.systemAudio": "Audio di sistema",
  "common.copyToClipboard": "Copia negli appunti",
  "common.copied": "Copiata negli appunti",
  "common.minimize": "Riduci a icona",
  "common.maximize": "Ingrandisci",
  "common.moreOptions": "Altre opzioni",

  // gallery
  "gallery.closeEsc": "Chiudi (Esc)",
  "gallery.about": "Informazioni su Screencup",
  "gallery.empty": "Nessuna cattura. Premi Stamp o usa il menu della tray icon.",
  "gallery.recordingSaved": "Registrazione salvata",
  "gallery.captured": "Catturata e copiata negli appunti",
  "gallery.recordingFailed": "Registrazione non riuscita: {error}",
  "gallery.audioWarning": "Audio: {warning}",
  "gallery.trashedOne": "Spostata nel cestino",
  "gallery.trashedMany": "{count} catture spostate nel cestino",
  "gallery.play": "Riproduci",
  "gallery.edit": "Modifica",
  "gallery.editMenu": "Modifica...",
  "gallery.openDefault": "Apri con l'app predefinita",
  "gallery.reveal": "Mostra nella cartella",
  "gallery.deleteMany": "Elimina {count} catture",
  "gallery.captureRegion": "Cattura una regione",
  "gallery.captureScreen": "Cattura lo schermo",
  "gallery.captureAll": "Cattura tutti gli schermi",
  "gallery.recordVideo": "Registra video",
  "gallery.recordRegion": "Registra una regione",
  "gallery.recordScreen": "Registra lo schermo",
  "gallery.publish": "Pubblica",
  "gallery.cloudSoon": "Cloud (in arrivo)",

  // editor
  "editor.copyAndExit": "Copia & Esci",
  "editor.copyAndExitHint": "Salva, copia negli appunti e chiudi",
  "editor.save": "Salva",
  "editor.saveHint": "Salva e chiudi (Ctrl+S salva senza chiudere)",
  "editor.copyImage": "Copia immagine",
  "editor.undo": "Annulla",
  "editor.redo": "Ripeti",
  "editor.deleteHint": "Elimina l'elemento selezionato (Canc)",
  "editor.color": "Colore",
  "editor.size": "Spessore",
  "editor.size0": "Sottile",
  "editor.size1": "Medio",
  "editor.size2": "Spesso",
  "editor.size3": "Molto spesso",
  "editor.zoomOut": "Riduci",
  "editor.zoomIn": "Ingrandisci",
  "editor.fit": "Adatta",
  "editor.unsaved": "Ci sono modifiche non salvate.",
  "editor.saveAndExit": "Salva ed esci",
  "editor.exitWithoutSaving": "Esci senza salvare",
  "editor.pngFailed": "Codifica PNG non riuscita",
  "editor.title": "Screencup editor - {name}",
  "tool.select": "Seleziona",
  "tool.arrow": "Freccia",
  "tool.line": "Linea",
  "tool.rect": "Rettangolo",
  "tool.ellipse": "Ellisse",
  "tool.highlight": "Evidenziatore",
  "tool.blur": "Sfocatura",
  "tool.text": "Testo",
  "tool.step": "Numero progressivo",

  // recording panel and frame
  "rec.stopAndSave": "Ferma e salva",
  "rec.cancelRecording": "Annulla la registrazione",
  "rec.start": "Avvia la registrazione",
  "rec.system": "Sistema",
  "rec.clicks": "Clic",
  "rec.reselect": "Riseleziona",
  "rec.moveArea": "Sposta l'area",

  // settings
  "settings.title": "Impostazioni di Screencup",
  "settings.general": "Generale",
  "settings.language": "Lingua",
  "settings.languageAuto": "Automatica (lingua di sistema)",
  "settings.autostart": "Avvia Screencup all'accesso al sistema",
  "settings.copyAfterCapture": "Copia negli appunti dopo ogni screenshot",
  "settings.showGallery": "Mostra la galleria dopo una cattura o una registrazione",
  "settings.library": "Cartella delle catture",
  "settings.openFolder": "Apri la cartella",
  "settings.change": "Cambia...",
  "settings.useDefault": "Usa la cartella predefinita",
  "settings.libraryHint": "Le catture già fatte restano nella cartella precedente.",
  "settings.limit": "Elimina le catture più vecchie oltre un numero massimo",
  "settings.limitCount": "Numero massimo di catture (le eccedenti vanno nel cestino)",
  "settings.hotkeys": "Scorciatoie da tastiera",
  "settings.hkCaptureRegion": "Cattura una regione",
  "settings.hkCaptureScreen": "Cattura lo schermo",
  "settings.hkCaptureAll": "Cattura tutti gli schermi",
  "settings.hkRecordRegion": "Registra una regione / Stop",
  "settings.hkRecordScreen": "Registra lo schermo / Stop",
  "settings.hkRemove": "Rimuovi la scorciatoia",
  "settings.hkNotRegistered": "Non registrata: {hotkey}",
  "settings.hkInputHint": "Clicca e premi la combinazione (Esc annulla, Backspace rimuove)",
  "settings.hkListening": "Premi la combinazione...",
  "settings.hkNone": "Nessuna",
  "settings.recording": "Registrazione video",
  "settings.recordMic": "Registra il microfono",
  "settings.recordSystem": "Registra l'audio di sistema",
  "settings.windowsOnly": "Solo Windows per ora",
  "settings.showClicks": "Evidenzia i clic del mouse",
  "settings.showClicksHint": "Un cerchio giallo (sinistro) o blu (destro) dove si clicca; solo Windows per ora",
  "settings.framerate": "Fotogrammi al secondo",
  "key.Shift": "Maiusc",
  "key.PrintScreen": "Stamp",
  "key.Space": "Spazio",

  // about
  "about.title": "Informazioni su Screencup",
  "about.version": "Versione {version}",
  "about.tagline": "Screenshot, annotazioni e registrazioni dello schermo.",
  "about.github": "Pagina GitHub",
  "about.licenses": "Licenze",
  "about.license": "Licenza MIT",
  "about.ffmpeg": "Include ffmpeg, distribuito con la propria licenza.",
};

export type Key = keyof typeof it;

const en: Record<Key, string> = {
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.delete": "Delete",
  "common.settings": "Settings",
  "common.microphone": "Microphone",
  "common.systemAudio": "System audio",
  "common.copyToClipboard": "Copy to clipboard",
  "common.copied": "Copied to clipboard",
  "common.minimize": "Minimize",
  "common.maximize": "Maximize",
  "common.moreOptions": "More options",

  "gallery.closeEsc": "Close (Esc)",
  "gallery.about": "About Screencup",
  "gallery.empty": "No captures yet. Press PrintScreen or use the tray icon menu.",
  "gallery.recordingSaved": "Recording saved",
  "gallery.captured": "Captured and copied to the clipboard",
  "gallery.recordingFailed": "Recording failed: {error}",
  "gallery.audioWarning": "Audio: {warning}",
  "gallery.trashedOne": "Moved to the trash",
  "gallery.trashedMany": "{count} captures moved to the trash",
  "gallery.play": "Play",
  "gallery.edit": "Edit",
  "gallery.editMenu": "Edit...",
  "gallery.openDefault": "Open with the default app",
  "gallery.reveal": "Show in folder",
  "gallery.deleteMany": "Delete {count} captures",
  "gallery.captureRegion": "Capture a region",
  "gallery.captureScreen": "Capture the screen",
  "gallery.captureAll": "Capture all screens",
  "gallery.recordVideo": "Record video",
  "gallery.recordRegion": "Record a region",
  "gallery.recordScreen": "Record the screen",
  "gallery.publish": "Share",
  "gallery.cloudSoon": "Cloud (coming soon)",

  "editor.copyAndExit": "Copy & Close",
  "editor.copyAndExitHint": "Save, copy to the clipboard and close",
  "editor.save": "Save",
  "editor.saveHint": "Save and close (Ctrl+S saves without closing)",
  "editor.copyImage": "Copy image",
  "editor.undo": "Undo",
  "editor.redo": "Redo",
  "editor.deleteHint": "Delete the selected element (Del)",
  "editor.color": "Color",
  "editor.size": "Thickness",
  "editor.size0": "Thin",
  "editor.size1": "Medium",
  "editor.size2": "Thick",
  "editor.size3": "Extra thick",
  "editor.zoomOut": "Zoom out",
  "editor.zoomIn": "Zoom in",
  "editor.fit": "Fit",
  "editor.unsaved": "There are unsaved changes.",
  "editor.saveAndExit": "Save and close",
  "editor.exitWithoutSaving": "Close without saving",
  "editor.pngFailed": "PNG encoding failed",
  "editor.title": "Screencup editor - {name}",
  "tool.select": "Select",
  "tool.arrow": "Arrow",
  "tool.line": "Line",
  "tool.rect": "Rectangle",
  "tool.ellipse": "Ellipse",
  "tool.highlight": "Highlighter",
  "tool.blur": "Blur",
  "tool.text": "Text",
  "tool.step": "Step number",

  "rec.stopAndSave": "Stop and save",
  "rec.cancelRecording": "Cancel the recording",
  "rec.start": "Start recording",
  "rec.system": "System",
  "rec.clicks": "Clicks",
  "rec.reselect": "Reselect",
  "rec.moveArea": "Move the area",

  "settings.title": "Screencup settings",
  "settings.general": "General",
  "settings.language": "Language",
  "settings.languageAuto": "Automatic (system language)",
  "settings.autostart": "Start Screencup when you sign in",
  "settings.copyAfterCapture": "Copy every screenshot to the clipboard",
  "settings.showGallery": "Show the gallery after a capture or a recording",
  "settings.library": "Captures folder",
  "settings.openFolder": "Open the folder",
  "settings.change": "Change...",
  "settings.useDefault": "Use the default folder",
  "settings.libraryHint": "Existing captures stay in the previous folder.",
  "settings.limit": "Delete the oldest captures beyond a maximum number",
  "settings.limitCount": "Maximum number of captures (extra ones go to the trash)",
  "settings.hotkeys": "Keyboard shortcuts",
  "settings.hkCaptureRegion": "Capture a region",
  "settings.hkCaptureScreen": "Capture the screen",
  "settings.hkCaptureAll": "Capture all screens",
  "settings.hkRecordRegion": "Record a region / Stop",
  "settings.hkRecordScreen": "Record the screen / Stop",
  "settings.hkRemove": "Remove the shortcut",
  "settings.hkNotRegistered": "Not registered: {hotkey}",
  "settings.hkInputHint": "Click and press the keys (Esc cancels, Backspace removes)",
  "settings.hkListening": "Press the keys...",
  "settings.hkNone": "None",
  "settings.recording": "Video recording",
  "settings.recordMic": "Record the microphone",
  "settings.recordSystem": "Record system audio",
  "settings.windowsOnly": "Windows only for now",
  "settings.showClicks": "Highlight mouse clicks",
  "settings.showClicksHint": "A yellow (left) or blue (right) circle where you click; Windows only for now",
  "settings.framerate": "Frames per second",
  "key.Shift": "Shift",
  "key.PrintScreen": "PrtSc",
  "key.Space": "Space",

  "about.title": "About Screencup",
  "about.version": "Version {version}",
  "about.tagline": "Screenshots, annotations and screen recordings.",
  "about.github": "GitHub page",
  "about.licenses": "Licences",
  "about.license": "MIT License",
  "about.ffmpeg": "Includes ffmpeg, distributed under its own licence.",
};

/** Mirrors `Lang` in src-tauri/src/i18n.rs. */
export type Lang = "it" | "en";

const DICTIONARIES: Record<Lang, Record<Key, string>> = { it, en };
let current: Lang = "en";

/** The language this window renders in. */
export const language = () => current;

/** Loads the resolved language; call before the first render. */
export async function initI18n(): Promise<void> {
  try {
    current = await invoke<Lang>("get_language");
  } catch {
    current = "en";
  }
  document.documentElement.lang = current;
}

/**
 * Reloads the window when a settings change switches the language, so every text is
 * rendered again in the new one.
 */
export function reloadOnLanguageChange(): void {
  listen("settings-changed", async () => {
    const lang = await invoke<Lang>("get_language").catch(() => current);
    if (lang !== current) window.location.reload();
  });
}

export function t(key: Key, params?: Record<string, string | number>): string {
  const text = DICTIONARIES[current][key] ?? it[key];
  return params ? text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m)) : text;
}
