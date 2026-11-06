import { type ReactNode, useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { FolderOpen, X } from "lucide-react";
import { type Key, t } from "./i18n";

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
  /** "auto" (system language) or a language code. */
  language: string;
  /** Default host for sharing: "litterbox" (temporary link) or "catbox" (permanent). */
  share_service: "litterbox" | "catbox";
  share_expiry_hours: number;
  share_confirmed: boolean;
  check_updates: boolean;
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

const HOTKEY_ROWS: { key: keyof Hotkeys; label: Key }[] = [
  { key: "capture_region", label: "settings.hkCaptureRegion" },
  { key: "capture_screen", label: "settings.hkCaptureScreen" },
  { key: "capture_all", label: "settings.hkCaptureAll" },
  { key: "record_region", label: "settings.hkRecordRegion" },
  { key: "record_screen", label: "settings.hkRecordScreen" },
];

/** Languages offered besides "auto"; each named in its own language. */
const LANGUAGES = [
  { value: "de", label: "Deutsch" },
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "it", label: "Italiano" },
  { value: "pt", label: "Português" },
];

/** Must match `EXPIRY_HOURS` in src-tauri/src/share.rs. */
export const SHARE_EXPIRIES = [1, 12, 24, 72];

/** Must match `FRAMERATES` in src-tauri/src/settings.rs. */
const FRAMERATES = [15, 30, 60];

const keyName = (part: string): string | undefined =>
  ({
    Control: "Ctrl",
    Shift: t("key.Shift"),
    Alt: "Alt",
    Super: "Win",
    PrintScreen: t("key.PrintScreen"),
    Space: t("key.Space"),
    Escape: "Esc",
  })[part];

/** `Control+Shift+KeyA` -> `Ctrl + Shift + A`, with key names in the UI language. */
export const formatAccelerator = (acc: string) =>
  acc
    .split("+")
    .map((part) => keyName(part) ?? part.replace(/^Key/, "").replace(/^Digit/, ""))
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
      title={t("settings.hkInputHint")}
    >
      {listening ? t("settings.hkListening") : value ? formatAccelerator(value) : t("settings.hkNone")}
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
      <span>{t("settings.limitCount")}</span>
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
      <Section title={t("settings.general")}>
        <label className="setting-select">
          <span>{t("settings.language")}</span>
          <select value={settings.language} onChange={(e) => update({ language: e.target.value })}>
            <option value="auto">{t("settings.languageAuto")}</option>
            {LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <Check
          label={t("settings.autostart")}
          checked={autostart}
          onChange={toggleAutostart}
        />
        <Check
          label={t("settings.checkUpdates")}
          checked={settings.check_updates}
          onChange={(v) => update({ check_updates: v })}
        />
        <Check
          label={t("settings.copyAfterCapture")}
          checked={settings.copy_after_capture}
          onChange={(v) => update({ copy_after_capture: v })}
        />
        <Check
          label={t("settings.showGallery")}
          checked={settings.show_gallery_after_capture}
          onChange={(v) => update({ show_gallery_after_capture: v })}
        />
      </Section>

      <Section title={t("settings.library")}>
        <div className="folder-row">
          <code title={settings.library_dir ?? defaultDir}>{settings.library_dir ?? defaultDir}</code>
          <button className="ghost" onClick={() => invoke("open_library_dir").catch((e) => notify(String(e)))} title={t("settings.openFolder")}>
            <FolderOpen size={16} />
          </button>
        </div>
        <div className="row-buttons">
          <button onClick={pickFolder}>{t("settings.change")}</button>
          <button className="ghost" disabled={!settings.library_dir} onClick={() => update({ library_dir: null })}>
            {t("settings.useDefault")}
          </button>
        </div>
        <p className="hint">{t("settings.libraryHint")}</p>
        <Check
          label={t("settings.limit")}
          checked={settings.max_captures > 0}
          onChange={(v) => update({ max_captures: v ? DEFAULT_MAX_CAPTURES : 0 })}
        />
        {settings.max_captures > 0 && (
          <MaxCapturesInput value={settings.max_captures} onChange={(v) => update({ max_captures: v })} />
        )}
      </Section>

      <Section title={t("settings.hotkeys")}>
        <div className="hotkeys">
          {HOTKEY_ROWS.map(({ key, label }) => (
            <div className="hotkey-row" key={key}>
              <span>{t(label)}</span>
              <HotkeyInput
                value={settings.hotkeys[key]}
                onChange={(v) => update({ hotkeys: { ...settings.hotkeys, [key]: v } })}
              />
              <button
                className="ghost icon"
                disabled={!settings.hotkeys[key]}
                onClick={() => update({ hotkeys: { ...settings.hotkeys, [key]: "" } })}
                title={t("settings.hkRemove")}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
        {hotkeyErrors.length > 0 && (
          <ul className="errors">
            {hotkeyErrors.map((e) => (
              <li key={e}>{t("settings.hkNotRegistered", { hotkey: e })}</li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t("settings.sharing")}>
        <label className="setting-select">
          <span>{t("settings.shareService")}</span>
          <select
            value={settings.share_service}
            onChange={(e) => update({ share_service: e.target.value as SettingsData["share_service"] })}
          >
            <option value="litterbox">{t("settings.shareLitterbox")}</option>
            <option value="catbox">{t("settings.shareCatbox")}</option>
          </select>
        </label>
        <label className="setting-select">
          <span>{t("settings.shareExpiry")}</span>
          <select
            value={settings.share_expiry_hours}
            onChange={(e) => update({ share_expiry_hours: Number(e.target.value) })}
          >
            {SHARE_EXPIRIES.map((h) => (
              <option key={h} value={h}>
                {t("settings.shareHours", { hours: h })}
              </option>
            ))}
          </select>
        </label>
        <p className="hint">{t("settings.shareHint")}</p>
      </Section>

      <Section title={t("settings.recording")}>
        <Check
          label={t("settings.recordMic")}
          checked={settings.record_microphone}
          onChange={(v) => update({ record_microphone: v })}
        />
        <Check
          label={t("settings.recordSystem")}
          hint={t("settings.windowsOnly")}
          checked={settings.record_system_audio}
          onChange={(v) => update({ record_system_audio: v })}
        />
        <Check
          label={t("settings.showClicks")}
          hint={t("settings.showClicksHint")}
          checked={settings.show_clicks}
          onChange={(v) => update({ show_clicks: v })}
        />
        <label className="setting-select">
          <span>{t("settings.framerate")}</span>
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
