import { type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Crop, Mic, MicOff, MousePointerClick, Move, Pause, Play, Settings, Video, VideoOff, Volume2, VolumeX, X } from "lucide-react";
import { patchSettings, type SettingsData } from "./Settings";
import { t } from "./i18n";

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
  /** Recorded time while paused (`recording-paused`); null while recording. */
  const [pausedMs, setPausedMs] = useState<number | null>(null);

  useEffect(() => {
    invoke<SettingsData>("get_settings").then(setSettings);
    const offSettings = listen<SettingsData>("settings-changed", (e) => setSettings(e.payload));
    const offStarted = listen<Started>("recording-started", (e) => {
      setStarted(e.payload);
      setPausedMs(null);
    });
    const offPaused = listen<number>("recording-paused", (e) => setPausedMs(e.payload));
    return () => {
      offSettings.then((f) => f());
      offStarted.then((f) => f());
      offPaused.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (!started || pausedMs !== null) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [started, pausedMs]);

  /** Pause / resume: the backend ends or starts a segment, which takes a moment. */
  const pauseOrResume = () => {
    setBusy(true);
    invoke(pausedMs === null ? "pause_recording" : "resume_recording").finally(() => setBusy(false));
  };

  const record = () => {
    setBusy(true);
    invoke("start_prepared").finally(() => setBusy(false));
  };
  const toggle = (patch: Partial<SettingsData>) => patchSettings(patch);

  if (started) {
    const paused = pausedMs !== null;
    const secs = Math.max(0, Math.floor((paused ? pausedMs : now - started.startedMs) / 1000));
    const time = `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}`;
    return (
      <div className="recbar" data-tauri-drag-region>
        <button className="rec-main stop" onClick={() => invoke("stop_recording")} title={t("rec.stopAndSave")}>
          <span className="rec-square" />
        </button>
        <button
          className="rec-pause"
          onClick={pauseOrResume}
          disabled={busy}
          title={paused ? t("rec.resume") : t("rec.pause")}
        >
          {paused ? <Play size={18} fill="currentColor" /> : <Pause size={18} fill="currentColor" />}
        </button>
        <span className={paused ? "rec-dot paused" : "rec-dot"} data-tauri-drag-region />
        <span className="rec-time" data-tauri-drag-region>
          {time}
        </span>
        {started.mic && <Mic size={16} className="rec-source" aria-label={t("common.microphone")} />}
        {started.system && <Volume2 size={16} className="rec-source" aria-label={t("common.systemAudio")} />}
        <div className="spacer" data-tauri-drag-region />
        <button className="rec-close" onClick={() => invoke("cancel_recording")} title={t("rec.cancelRecording")}>
          <X size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="recbar" data-tauri-drag-region>
      <button className="rec-main" onClick={record} disabled={busy || !settings} title={t("rec.start")}>
        <span className="rec-circle" />
      </button>
      <Toggle
        icon={settings?.record_microphone ? <Mic size={20} /> : <MicOff size={20} />}
        label={t("common.microphone")}
        on={settings?.record_microphone}
        onClick={() => toggle({ record_microphone: !settings?.record_microphone })}
      />
      <Toggle
        icon={settings?.record_system_audio ? <Volume2 size={20} /> : <VolumeX size={20} />}
        label={t("rec.system")}
        on={settings?.record_system_audio}
        onClick={() => toggle({ record_system_audio: !settings?.record_system_audio })}
      />
      <Toggle
        icon={<MousePointerClick size={20} />}
        label={t("rec.clicks")}
        on={settings?.show_clicks}
        onClick={() => toggle({ show_clicks: !settings?.show_clicks })}
      />
      <Toggle
        icon={settings?.record_webcam ? <Video size={20} /> : <VideoOff size={20} />}
        label={t("rec.webcam")}
        on={settings?.record_webcam}
        onClick={() => invoke("toggle_webcam")}
      />
      <Toggle icon={<Crop size={20} />} label={t("rec.reselect")} onClick={() => invoke("reselect_region")} />
      <Toggle icon={<Settings size={20} />} label={t("common.settings")} onClick={() => invoke("open_settings")} />
      <div className="spacer" data-tauri-drag-region />
      <button className="rec-close" onClick={() => invoke("cancel_recording")} title={t("common.cancel")}>
        <X size={16} />
      </button>
    </div>
  );
}

/** Geometry from `open_frame` in src-tauri/src/recorder.rs, in logical pixels. */
export interface FrameProps {
  /** Initial area size, physical pixels. */
  width: number;
  height: number;
  /** Ring around the area holding the dashed line and the resize grips. */
  margin: number;
  /** Side of the corner resize handles, from the window corners. */
  corner: number;
  /** Diameter of the move handle in the middle. */
  grip: number;
}

type Edge = "North" | "South" | "East" | "West" | "NorthWest" | "NorthEast" | "SouthWest" | "SouthEast";

const EDGES: { dir: Edge; cursor: string; style: CSSProperties }[] = [
  { dir: "North", cursor: "ns-resize", style: { top: 0, left: 0, right: 0, height: "var(--m)" } },
  { dir: "South", cursor: "ns-resize", style: { bottom: 0, left: 0, right: 0, height: "var(--m)" } },
  { dir: "West", cursor: "ew-resize", style: { left: 0, top: 0, bottom: 0, width: "var(--m)" } },
  { dir: "East", cursor: "ew-resize", style: { right: 0, top: 0, bottom: 0, width: "var(--m)" } },
  { dir: "NorthWest", cursor: "nwse-resize", style: { top: 0, left: 0 } },
  { dir: "NorthEast", cursor: "nesw-resize", style: { top: 0, right: 0 } },
  { dir: "SouthWest", cursor: "nesw-resize", style: { bottom: 0, left: 0 } },
  { dir: "SouthEast", cursor: "nwse-resize", style: { bottom: 0, right: 0 } },
];

const areaSize = (margin: number) => ({
  width: Math.round((window.innerWidth - 2 * margin) * window.devicePixelRatio) & ~1,
  height: Math.round((window.innerHeight - 2 * margin) * window.devicePixelRatio) & ~1,
});

/**
 * Dashed frame around the area to record; see `open_frame` in src-tauri/src/recorder.rs.
 * Until recording starts, the ring and corners resize it and the middle handle moves it
 * (the OS does the dragging); afterwards it only shows the area.
 */
export function RecFrame({ width, height, margin, corner, grip }: FrameProps) {
  const [size, setSize] = useState({ width, height });
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    document.documentElement.classList.add("clickfx");
    const onResize = () => setSize(areaSize(margin));
    window.addEventListener("resize", onResize);
    const off = listen("recording-started", () => {
      setRecording(true);
      setPaused(false);
    });
    const offPaused = listen("recording-paused", () => setPaused(true));
    return () => {
      window.removeEventListener("resize", onResize);
      off.then((f) => f());
      offPaused.then((f) => f());
    };
  }, [margin]);

  const press = (action: () => Promise<void>) => (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    action().catch(() => {});
  };
  const win = getCurrentWindow();
  const vars = { "--m": `${margin}px`, "--c": `${corner}px`, "--g": `${grip}px` } as CSSProperties;

  return (
    <div className={recording ? (paused ? "recframe recording paused" : "recframe recording") : "recframe"} style={vars}>
      <div className="recframe-line" />
      {!recording && (
        <>
          {EDGES.map(({ dir, cursor, style }) => (
            <div
              key={dir}
              className={dir.length > 5 ? "recframe-corner" : "recframe-edge"}
              style={{ ...style, cursor }}
              onMouseDown={press(() => win.startResizeDragging(dir))}
            />
          ))}
          <div className="recframe-grip" title={t("rec.moveArea")} onMouseDown={press(() => win.startDragging())}>
            <Move size={20} />
          </div>
        </>
      )}
      <span className="recframe-size">
        {size.width} × {size.height}
      </span>
    </div>
  );
}
