import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowLeftToLine, ArrowRightToLine, Film, Pause, Play, Scissors, X } from "lucide-react";
import { t } from "./i18n";
import { RibbonButton } from "./ui";

/** GIF widths offered; 0 keeps the recording's width. Must match `GIF_WIDTHS` in src-tauri/src/video.rs. */
const GIF_WIDTHS = [0, 1280, 960, 640, 480];
const GIF_FRAMERATES = [10, 15, 20];
/** Shortest stretch that can be kept, in seconds. */
const MIN_LENGTH = 0.1;

const win = getCurrentWindow();

/** 75.3 -> "1:15.3" */
const clock = (s: number) => {
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, "0")}`;
};

/**
 * Video editor window (see `open_video_editor` in src-tauri/src/video.rs): a player with a
 * trim bar. The handles pick the stretch to keep; Apply trim rewrites the recording, Export
 * GIF saves that stretch as an animated GIF.
 */
export function VideoEditorWindow({ name, notify }: { name: string; notify: (message: string, long?: boolean) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [range, setRange] = useState({ start: 0, end: 0 });
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [gif, setGif] = useState<{ width: number; fps: number } | null>(null);

  const load = useCallback(
    () =>
      invoke<string>("video_source", { name })
        // The query defeats the webview cache after the file was rewritten by a trim.
        .then((path) => setSrc(`${convertFileSrc(path)}?v=${Date.now()}`))
        .catch((e) => notify(String(e), true)),
    [name, notify],
  );
  useEffect(() => {
    load();
  }, [load]);

  const video = () => videoRef.current;
  const seek = (s: number) => {
    const v = video();
    if (v) v.currentTime = Math.max(0, Math.min(duration, s));
  };

  const togglePlay = () => {
    const v = video();
    if (!v) return;
    if (v.paused) {
      // Playback stays inside the kept stretch.
      if (v.currentTime < range.start || v.currentTime >= range.end - 0.05) v.currentTime = range.start;
      v.play();
    } else v.pause();
  };

  const onTime = () => {
    const v = video();
    if (!v) return;
    setTime(v.currentTime);
    if (!v.paused && v.currentTime >= range.end) {
      v.pause();
      v.currentTime = range.end;
    }
  };

  // --- trim bar ----------------------------------------------------------------------------

  const timeAt = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    return (Math.max(0, Math.min(r.width, clientX - r.left)) / r.width) * duration;
  };

  /** Drags a handle (or the playhead) with the pointer captured on the track. */
  const drag = (which: "start" | "end" | "head") => (e: ReactPointerEvent) => {
    if (e.button !== 0 || !duration) return;
    e.preventDefault();
    e.stopPropagation();
    video()?.pause();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (clientX: number) => {
      const s = timeAt(clientX);
      if (which === "head") seek(s);
      else
        setRange((r) => {
          const next =
            which === "start"
              ? { ...r, start: Math.min(s, r.end - MIN_LENGTH) }
              : { ...r, end: Math.max(s, r.start + MIN_LENGTH) };
          seek(which === "start" ? next.start : next.end);
          return next;
        });
    };
    move(e.clientX);
    const onMove = (ev: PointerEvent) => move(ev.clientX);
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  };

  const setIn = () => setRange((r) => ({ ...r, start: Math.min(time, r.end - MIN_LENGTH) }));
  const setOut = () => setRange((r) => ({ ...r, end: Math.max(time, r.start + MIN_LENGTH) }));

  // --- actions -------------------------------------------------------------------------------

  const trimmed = duration > 0 && (range.start > 0.05 || range.end < duration - 0.05);

  const applyTrim = async () => {
    setBusy(true);
    // Release the file: the webview keeps it open while it is the video source.
    setSrc(null);
    try {
      await invoke("trim_video", { name, start: range.start, end: range.end });
      notify(t("video.trimmed"));
    } catch (e) {
      notify(t("video.failed", { error: String(e) }), true);
    } finally {
      setBusy(false);
      setDuration(0);
      load();
    }
  };

  const exportGif = async () => {
    if (!gif) return;
    const { width, fps } = gif;
    setGif(null);
    setBusy(true);
    notify(t("video.gifWorking"));
    try {
      const path = await invoke<string | null>("export_gif", { name, start: range.start, end: range.end, width, fps });
      if (path) notify(t("editor.exported", { path }));
    } catch (e) {
      notify(t("video.failed", { error: String(e) }), true);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (gif || e.target instanceof HTMLSelectElement) return;
      const key = e.key.toLowerCase();
      if (key === " ") togglePlay();
      else if (key === "i") setIn();
      else if (key === "o") setOut();
      else if (key === "escape") win.close();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const pct = (s: number) => (duration ? `${(s / duration) * 100}%` : "0%");

  return (
    <div className="video-editor">
      <header className="ribbon">
        <RibbonButton
          icon={<Scissors size={20} />}
          tint="#2d8cff"
          label={t("video.applyTrim")}
          onClick={applyTrim}
          disabled={busy || !trimmed}
          title={t("video.applyTrimHint")}
        />
        <RibbonButton
          icon={<Film size={20} />}
          tint="#8e4ec6"
          label={t("video.exportGif")}
          onClick={() => setGif({ width: 640, fps: 15 })}
          disabled={busy || !duration}
          title={t("video.exportGifHint")}
        />
        <div className="ribbon-sep" />
        <RibbonButton
          icon={<ArrowLeftToLine size={20} />}
          tint="#30a46c"
          label={t("video.setStart")}
          onClick={setIn}
          disabled={!duration}
          title="I"
        />
        <RibbonButton
          icon={<ArrowRightToLine size={20} />}
          tint="#30a46c"
          label={t("video.setEnd")}
          onClick={setOut}
          disabled={!duration}
          title="O"
        />
        <div className="spacer" />
        <RibbonButton icon={<X size={20} />} tint="#f76b15" label={t("common.close")} onClick={() => win.close()} />
      </header>

      <div className="video-stage">
        {src && (
          <video
            ref={videoRef}
            src={src}
            preload="auto"
            onLoadedMetadata={(e) => {
              const d = e.currentTarget.duration;
              setDuration(d);
              setRange({ start: 0, end: d });
            }}
            onTimeUpdate={onTime}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onClick={togglePlay}
          />
        )}
      </div>

      <footer className="video-controls">
        <button className="video-play" onClick={togglePlay} disabled={!duration} title={t("video.playPause")}>
          {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
        </button>
        <div className="trim-track" ref={trackRef} onPointerDown={drag("head")}>
          <div className="trim-kept" style={{ left: pct(range.start), width: pct(range.end - range.start) }} />
          <div className="trim-playhead" style={{ left: pct(time) }} />
          <div className="trim-handle" style={{ left: pct(range.start) }} onPointerDown={drag("start")} title={t("video.setStart")} />
          <div className="trim-handle end" style={{ left: pct(range.end) }} onPointerDown={drag("end")} title={t("video.setEnd")} />
        </div>
        <span className="trim-times">
          {clock(time)} · {t("video.kept", { start: clock(range.start), end: clock(range.end), length: clock(range.end - range.start) })}
        </span>
      </footer>

      {gif && (
        <div className="modal-backdrop">
          <form
            className="modal resize-modal"
            onSubmit={(e) => {
              e.preventDefault();
              exportGif();
            }}
          >
            <h3>{t("video.exportGif")}</h3>
            <label>
              <span>{t("editor.width")}</span>
              <select value={gif.width} onChange={(e) => setGif({ ...gif, width: Number(e.target.value) })}>
                {GIF_WIDTHS.map((w) => (
                  <option key={w} value={w}>
                    {w === 0 ? t("editor.originalSize") : `${w} px`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t("settings.framerate")}</span>
              <select value={gif.fps} onChange={(e) => setGif({ ...gif, fps: Number(e.target.value) })}>
                {GIF_FRAMERATES.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
            <p className="hint">{t("video.gifHint", { length: clock(range.end - range.start) })}</p>
            <div className="modal-buttons">
              <button type="submit">{t("video.exportGif")}</button>
              <button type="button" className="ghost" onClick={() => setGif(null)}>
                {t("common.cancel")}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
