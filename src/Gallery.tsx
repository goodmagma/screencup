import { useCallback, useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Camera, CloudUpload, Maximize2, Minus, PencilRuler, Play, Settings, Video, X } from "lucide-react";
import { patchSettings, type SettingsData } from "./Settings";
import { BigButton, Menu, type MenuItem } from "./ui";

/** Mirrors `Capture` in src-tauri/src/library.rs. */
interface Capture {
  path: string;
  name: string;
  modified_ms: number;
  video: boolean;
}

/** Mirrors `CaptureKind` in src-tauri/src/capture.rs. */
type CaptureKind = "region" | "screen" | "all";

/** Mirrors `RecordKind` in src-tauri/src/recorder.rs. */
type RecordKind = "region" | "screen";

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const win = getCurrentWindow();

export function Gallery({ notify }: { notify: (message: string) => void }) {
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [context, setContext] = useState<{ x: number; y: number; name: string } | null>(null);
  const [settings, setSettings] = useState<SettingsData | null>(null);

  useEffect(() => {
    invoke<SettingsData>("get_settings").then(setSettings).catch((e) => notify(String(e)));
    const off = listen<SettingsData>("settings-changed", (e) => setSettings(e.payload));
    return () => {
      off.then((f) => f());
    };
  }, [notify]);

  const updateSettings = (patch: Partial<SettingsData>) => patchSettings(patch).catch((e) => notify(String(e)));

  const refresh = useCallback(
    () =>
      invoke<Capture[]>("list_captures")
        .then(setCaptures)
        .catch((e) => notify(String(e))),
    [notify],
  );

  useEffect(() => {
    refresh();
    const added = listen<string>("capture-added", (event) => {
      refresh();
      const name = baseName(event.payload);
      setSelected(name);
      notify(name.endsWith(".mp4") ? "Registrazione salvata" : "Catturata e copiata negli appunti");
    });
    const updated = listen("capture-updated", refresh);
    const failed = listen<string>("recording-error", (event) => notify(`Registrazione non riuscita: ${event.payload}`));
    const warned = listen<string>("recording-warning", (event) => notify(`Audio: ${event.payload}`));
    return () => {
      added.then((off) => off());
      updated.then((off) => off());
      failed.then((off) => off());
      warned.then((off) => off());
    };
  }, [refresh, notify]);

  const capture = (kind: CaptureKind) => invoke("capture", { kind });
  const record = (kind: RecordKind) => invoke("toggle_recording", { kind });
  const isVideo = (name: string) => captures.find((c) => c.name === name)?.video ?? false;
  const open = (name: string) => invoke("open_capture", { name }).catch((e) => notify(String(e)));
  const reveal = (name: string) => invoke("reveal_capture", { name }).catch((e) => notify(String(e)));
  /** Images open in the editor; videos in the system player. */
  const edit = (name: string) =>
    isVideo(name) ? open(name) : invoke("open_editor", { name }).catch((e) => notify(String(e)));

  const copy = useCallback(
    (name: string) =>
      invoke("copy_capture", { name })
        .then(() => notify("Copiata negli appunti"))
        .catch((e) => notify(String(e))),
    [notify],
  );

  const remove = useCallback(
    (name: string) =>
      invoke("delete_capture", { name })
        .then(() => {
          setSelected((s) => (s === name ? null : s));
          notify("Spostata nel cestino");
          return refresh();
        })
        .catch((e) => notify(String(e))),
    [notify, refresh],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") win.hide();
      if (!selected) return;
      if (e.key === "Delete") remove(selected);
      else if (e.key === "Enter") edit(selected);
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") copy(selected);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const itemActions = (name: string): MenuItem[] => {
    const video = isVideo(name);
    return [
      { label: video ? "Riproduci" : "Modifica", onSelect: () => edit(name) },
      { label: "Copia negli appunti", onSelect: () => copy(name), disabled: video },
      { label: "Apri con l'app predefinita", onSelect: () => open(name) },
      { label: "Mostra nella cartella", onSelect: () => reveal(name) },
      { label: "Elimina", onSelect: () => remove(name), danger: true },
    ];
  };

  return (
    <div className="gallery">
      <header className="titlebar" data-tauri-drag-region>
        <img src="/app-icon.svg" alt="" className="titlebar-icon" data-tauri-drag-region />
        <span data-tauri-drag-region>Screencup</span>
        <div className="titlebar-buttons">
          <button onClick={() => invoke("open_settings")} title="Impostazioni">
            <Settings size={15} />
          </button>
          <button onClick={() => win.minimize()} title="Riduci a icona">
            <Minus size={16} />
          </button>
          <button onClick={() => win.toggleMaximize()} title="Ingrandisci">
            <Maximize2 size={14} />
          </button>
          <button onClick={() => win.hide()} title="Chiudi (Esc)">
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="gallery-grid" onClick={() => setSelected(null)}>
        {captures.length === 0 ? (
          <p className="empty">Nessuna cattura. Premi Stamp o usa il menu della tray icon.</p>
        ) : (
          captures.map((c) => (
            <figure
              key={c.name}
              className={c.name === selected ? "tile selected" : "tile"}
              onClick={(e) => {
                e.stopPropagation();
                setSelected(c.name);
              }}
              onDoubleClick={() => edit(c.name)}
              onContextMenu={(e) => {
                e.preventDefault();
                setSelected(c.name);
                setContext({ x: e.clientX, y: e.clientY, name: c.name });
              }}
            >
              <div className="tile-image">
                <img src={`${convertFileSrc(c.name, "thumb")}?v=${c.modified_ms}`} alt="" loading="lazy" />
                {c.video && (
                  <span className="play-badge">
                    <Play size={18} fill="currentColor" />
                  </span>
                )}
              </div>
              <figcaption>{c.name}</figcaption>
            </figure>
          ))
        )}
      </div>

      <footer className="action-bar">
        <BigButton
          icon={<Camera size={28} />}
          label="Cattura una regione"
          ring="#e5484d"
          onClick={() => capture("region")}
          menu={[
            { label: "Cattura una regione (Stamp)", onSelect: () => capture("region") },
            { label: "Cattura lo schermo (Maiusc+Stamp)", onSelect: () => capture("screen") },
            { label: "Cattura tutti gli schermi", onSelect: () => capture("all") },
          ]}
        />
        <BigButton
          icon={<Video size={28} />}
          label="Registra video"
          ring="#e5484d"
          onClick={() => record("region")}
          menu={[
            { label: "Registra una regione (Ctrl+Stamp)", onSelect: () => record("region") },
            { label: "Registra lo schermo (Ctrl+Maiusc+Stamp)", onSelect: () => record("screen") },
            {
              label: "Microfono",
              checked: settings?.record_microphone ?? false,
              onSelect: () => updateSettings({ record_microphone: !settings?.record_microphone }),
            },
            {
              label: "Audio di sistema",
              checked: settings?.record_system_audio ?? false,
              onSelect: () => updateSettings({ record_system_audio: !settings?.record_system_audio }),
            },
          ]}
        />
        <BigButton
          icon={<PencilRuler size={26} />}
          label={selected && isVideo(selected) ? "Riproduci" : "Modifica..."}
          ring="#30a46c"
          disabled={!selected}
          onClick={() => selected && edit(selected)}
          menu={selected ? itemActions(selected).slice(1) : undefined}
        />
        <BigButton
          icon={<CloudUpload size={28} />}
          label="Pubblica"
          ring="#2d8cff"
          disabled={!selected}
          onClick={() => selected && copy(selected)}
          menu={
            selected
              ? [
                  { label: "Copia negli appunti", onSelect: () => copy(selected) },
                  { label: "Mostra nella cartella", onSelect: () => reveal(selected) },
                  { label: "Cloud (in arrivo)", onSelect: () => {}, disabled: true },
                ]
              : undefined
          }
        />
        <div className="spacer" />
        <BigButton icon={<X size={28} />} label="Chiudi" ring="#f76b15" onClick={() => win.hide()} />
      </footer>

      {context && (
        <Menu
          items={itemActions(context.name)}
          onClose={() => setContext(null)}
          style={{ position: "fixed", left: context.x, top: context.y }}
        />
      )}
    </div>
  );
}
