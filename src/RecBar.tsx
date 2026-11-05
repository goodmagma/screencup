import { type ReactNode, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Crop, Mic, MicOff, MousePointerClick, Settings, Volume2, VolumeX, X } from "lucide-react";
import { patchSettings, type SettingsData } from "./Settings";

/** Mirrors `RecordingStarted` in src-tauri/src/recorder.rs. */
interface Started {
  startedMs: number;
  mic: boolean;
  system: boolean;
}

const pad = (n: number) => String(n).padStart(2, "0");

function Toggle({ icon, label, on, onClick, disabled }: { icon: ReactNode; label: string; on?: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button className={on === false ? "panel-toggle off" : "panel-toggle"} onClick={onClick} disabled={disabled}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

/**
 * Control panel shown with the dashed frame (see `open_bar` in src-tauri/src/recorder.rs):
 * first to set up and start the recording, then, once `recording-started` arrives, with the
 * elapsed time and Stop.
 */
export function RecBar() {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [started, setStarted] = useState<Started | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    invoke<SettingsData>("get_settings").then(setSettings);
    const offSettings = listen<SettingsData>("settings-changed", (e) => setSettings(e.payload));
    const offStarted = listen<Started>("recording-started", (e) => setStarted(e.payload));
    return () => {
      offSettings.then((f) => f());
      offStarted.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (!started) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [started]);

  const record = () => {
    setBusy(true);
    invoke("start_prepared").finally(() => setBusy(false));
  };
  const toggle = (patch: Partial<SettingsData>) => patchSettings(patch);

  if (started) {
    const secs = Math.max(0, Math.floor((now - started.startedMs) / 1000));
    const time = `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}`;
    return (
      <div className="recbar" data-tauri-drag-region>
        <button className="rec-main stop" onClick={() => invoke("stop_recording")} title="Ferma e salva">
          <span className="rec-square" />
        </button>
        <span className="rec-dot" data-tauri-drag-region />
        <span className="rec-time" data-tauri-drag-region>
          {time}
        </span>
        {started.mic && <Mic size={16} className="rec-source" aria-label="Microfono" />}
        {started.system && <Volume2 size={16} className="rec-source" aria-label="Audio di sistema" />}
        <div className="spacer" data-tauri-drag-region />
        <button className="rec-close" onClick={() => invoke("cancel_recording")} title="Annulla la registrazione">
          <X size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="recbar" data-tauri-drag-region>
      <button className="rec-main" onClick={record} disabled={busy || !settings} title="Avvia la registrazione">
        <span className="rec-circle" />
      </button>
      <Toggle
        icon={settings?.record_microphone ? <Mic size={20} /> : <MicOff size={20} />}
        label="Microfono"
        on={settings?.record_microphone}
        onClick={() => toggle({ record_microphone: !settings?.record_microphone })}
      />
      <Toggle
        icon={settings?.record_system_audio ? <Volume2 size={20} /> : <VolumeX size={20} />}
        label="Sistema"
        on={settings?.record_system_audio}
        onClick={() => toggle({ record_system_audio: !settings?.record_system_audio })}
      />
      <Toggle
        icon={<MousePointerClick size={20} />}
        label="Clic"
        on={settings?.show_clicks}
        onClick={() => toggle({ show_clicks: !settings?.show_clicks })}
      />
      <Toggle icon={<Crop size={20} />} label="Riseleziona" onClick={() => invoke("reselect_region")} />
      <Toggle icon={<Settings size={20} />} label="Impostazioni" onClick={() => invoke("open_settings")} />
      <div className="spacer" data-tauri-drag-region />
      <button className="rec-close" onClick={() => invoke("cancel_recording")} title="Annulla">
        <X size={16} />
      </button>
    </div>
  );
}

/** Dashed frame around the area to record; see `open_frame` in src-tauri/src/recorder.rs. */
export function RecFrame({ width, height }: { width: number; height: number }) {
  useEffect(() => document.documentElement.classList.add("clickfx"), []);
  return (
    <div className="recframe">
      <span className="recframe-size">
        {width} × {height}
      </span>
    </div>
  );
}
