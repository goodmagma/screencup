import { type ReactNode, useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { FolderOpen, X } from "lucide-react";

/** Mirrors `Settings` in src-tauri/src/settings.rs. */
export interface SettingsData {
  library_dir: string | null;
  copy_after_capture: boolean;
  show_gallery_after_capture: boolean;
  record_microphone: boolean;
  record_system_audio: boolean;
  show_clicks: boolean;
  framerate: number;
  hotkeys: Hotkeys;
  /** 0 = no limit. */
  max_captures: number;
}

/**
 * Saves a partial change on top of the stored settings (not a possibly stale local copy:
 * the gallery and the settings window both edit them). Returns the hotkeys that failed.
 */
export async function patchSettings(patch: Partial<SettingsData>): Promise<string[]> {
  const current = await invoke<SettingsData>("get_settings");
  return invoke<string[]>("set_settings", { settings: { ...current, ...patch } });
}

/** Mirrors `Hotkeys` in src-tauri/src/settings.rs. */
interface Hotkeys {
  capture_region: string;
  capture_screen: string;
  capture_all: string;
  record_region: string;
  record_screen: string;
}

const HOTKEY_ROWS: { key: keyof Hotkeys; label: string }[] = [
  { key: "capture_region", label: "Cattura una regione" },
  { key: "capture_screen", label: "Cattura lo schermo" },
  { key: "capture_all", label: "Cattura tutti gli schermi" },
  { key: "record_region", label: "Registra una regione / Stop" },
  { key: "record_screen", label: "Registra lo schermo / Stop" },
];

/** Must match `FRAMERATES` in src-tauri/src/settings.rs. */
const FRAMERATES = [15, 30, 60];

const KEY_NAMES: Record<string, string> = {
  Control: "Ctrl",
  Shift: "Maiusc",
  Alt: "Alt",
  Super: "Win",
  PrintScreen: "Stamp",
  Space: "Spazio",
  Escape: "Esc",
};

/** `Control+Shift+KeyA` -> `Ctrl + Maiusc + A`. */
const formatAccelerator = (acc: string) =>
  acc
    .split("+")
    .map((part) => KEY_NAMES[part] ?? part.replace(/^Key/, "").replace(/^Digit/, ""))
    .join(" + ");

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "OS"]);

/** Accelerator in the global-hotkey syntax: modifiers, then the physical key code. */
function acceleratorOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Control");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Super");
  parts.push(e.code);
  return parts.join("+");
}

/** Click, then press the combination. Esc cancels, Backspace clears the shortcut. */
function HotkeyInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [listening, setListening] = useState(false);

  useEffect(() => {
    if (!listening) return;
    // The global shortcuts would fire (e.g. PrintScreen starts a capture) while typing one.
    invoke("suspend_hotkeys", { suspended: true });
    const finish = (next: string | null) => {
      setListening(false);
      // Saving re-registers the shortcuts; with no change, resume them explicitly.
      if (next === null || next === value) invoke("suspend_hotkeys", { suspended: false });
      else onChange(next);
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (MODIFIER_KEYS.has(e.key)) return;
      const bare = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
      if (bare && e.key === "Escape") finish(null);
      else if (bare && (e.key === "Backspace" || e.key === "Delete")) finish("");
      else finish(acceleratorOf(e));
    };
    // Windows only reports PrintScreen on key up.
    const onKeyUp = (e: KeyboardEvent) => e.code === "PrintScreen" && onKey(e);
    const onBlur = () => finish(null);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [listening, value, onChange]);

  return (
    <button
      className={listening ? "hotkey listening" : "hotkey"}
      onClick={() => setListening(true)}
      title="Clicca e premi la combinazione (Esc annulla, Backspace rimuove)"
    >
      {listening ? "Premi la combinazione..." : value ? formatAccelerator(value) : "Nessuna"}
    </button>
  );
}

function Check({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="setting-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

const DEFAULT_MAX_CAPTURES = 500;
const MIN_MAX_CAPTURES = 10;

/**
 * Applied on Enter or blur, not per keystroke: typing "500" passes through "5", which
 * would already send all but five captures to the trash.
 */
function MaxCapturesInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const apply = () => {
    const n = Math.max(MIN_MAX_CAPTURES, Math.floor(Number(text)) || DEFAULT_MAX_CAPTURES);
    setText(String(n));
    if (n !== value) onChange(n);
  };
  return (
    <label className="setting-select">
      <span>Numero massimo di catture (le eccedenti vanno nel cestino)</span>
      <input
        type="number"
        min={MIN_MAX_CAPTURES}
        step={50}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => e.key === "Enter" && apply()}
      />
    </label>
  );
}

export function SettingsWindow({ notify }: { notify: (message: string) => void }) {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [autostart, setAutostart] = useState(false);
  const [defaultDir, setDefaultDir] = useState("");
  const [hotkeyErrors, setHotkeyErrors] = useState<string[]>([]);

  useEffect(() => {
    Promise.all([
      invoke<SettingsData>("get_settings"),
      invoke<boolean>("get_autostart"),
      invoke<string>("default_library_dir"),
    ])
      .then(([s, a, d]) => {
        setSettings(s);
        setAutostart(a);
        setDefaultDir(d);
      })
      .catch((e) => notify(String(e)));
  }, [notify]);

  useEffect(() => {
    const off = listen<SettingsData>("settings-changed", (e) => setSettings(e.payload));
    return () => {
      off.then((f) => f());
    };
  }, []);

  /** Every change is saved right away; hotkeys are re-registered by the backend. */
  const update = useCallback(
    (patch: Partial<SettingsData>) =>
      patchSettings(patch)
        .then(setHotkeyErrors)
        .catch((e) => notify(String(e))),
    [notify],
  );

  const toggleAutostart = (enabled: boolean) =>
    invoke("set_autostart", { enabled })
      .then(() => setAutostart(enabled))
      .catch((e) => notify(String(e)));

  const pickFolder = () =>
    invoke<string | null>("pick_library_dir")
      .then((dir) => {
        if (dir) update({ library_dir: dir });
      })
      .catch((e) => notify(String(e)));

  if (!settings) return null;

  return (
    <div className="settings">
      <Section title="Generale">
        <Check
          label="Avvia Screencup all'accesso al sistema"
          checked={autostart}
          onChange={toggleAutostart}
        />
        <Check
          label="Copia negli appunti dopo ogni screenshot"
          checked={settings.copy_after_capture}
          onChange={(v) => update({ copy_after_capture: v })}
        />
        <Check
          label="Mostra la galleria dopo una cattura o una registrazione"
          checked={settings.show_gallery_after_capture}
          onChange={(v) => update({ show_gallery_after_capture: v })}
        />
      </Section>

      <Section title="Cartella delle catture">
        <div className="folder-row">
          <code title={settings.library_dir ?? defaultDir}>{settings.library_dir ?? defaultDir}</code>
          <button className="ghost" onClick={() => invoke("open_library_dir").catch((e) => notify(String(e)))} title="Apri la cartella">
            <FolderOpen size={16} />
          </button>
        </div>
        <div className="row-buttons">
          <button onClick={pickFolder}>Cambia...</button>
          <button className="ghost" disabled={!settings.library_dir} onClick={() => update({ library_dir: null })}>
            Usa la cartella predefinita
          </button>
        </div>
        <p className="hint">Le catture già fatte restano nella cartella precedente.</p>
        <Check
          label="Elimina le catture più vecchie oltre un numero massimo"
          checked={settings.max_captures > 0}
          onChange={(v) => update({ max_captures: v ? DEFAULT_MAX_CAPTURES : 0 })}
        />
        {settings.max_captures > 0 && (
          <MaxCapturesInput value={settings.max_captures} onChange={(v) => update({ max_captures: v })} />
        )}
      </Section>

      <Section title="Scorciatoie da tastiera">
        <div className="hotkeys">
          {HOTKEY_ROWS.map(({ key, label }) => (
            <div className="hotkey-row" key={key}>
              <span>{label}</span>
              <HotkeyInput
                value={settings.hotkeys[key]}
                onChange={(v) => update({ hotkeys: { ...settings.hotkeys, [key]: v } })}
              />
              <button
                className="ghost icon"
                disabled={!settings.hotkeys[key]}
                onClick={() => update({ hotkeys: { ...settings.hotkeys, [key]: "" } })}
                title="Rimuovi la scorciatoia"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
        {hotkeyErrors.length > 0 && (
          <ul className="errors">
            {hotkeyErrors.map((e) => (
              <li key={e}>Non registrata: {e}</li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Registrazione video">
        <Check
          label="Registra il microfono"
          checked={settings.record_microphone}
          onChange={(v) => update({ record_microphone: v })}
        />
        <Check
          label="Registra l'audio di sistema"
          hint="Solo Windows per ora"
          checked={settings.record_system_audio}
          onChange={(v) => update({ record_system_audio: v })}
        />
        <Check
          label="Evidenzia i clic del mouse"
          hint="Un cerchio giallo (sinistro) o blu (destro) dove si clicca; solo Windows per ora"
          checked={settings.show_clicks}
          onChange={(v) => update({ show_clicks: v })}
        />
        <label className="setting-select">
          <span>Fotogrammi al secondo</span>
          <select value={settings.framerate} onChange={(e) => update({ framerate: Number(e.target.value) })}>
            {FRAMERATES.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
      </Section>
    </div>
  );
}
