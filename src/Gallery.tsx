import { type MouseEvent, useCallback, useEffect, useRef, useState } from "react";
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

/** Pointer travel, in CSS pixels, before a press on a tile starts dragging it out. */
const DRAG_START = 6;

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const win = getCurrentWindow();

export function Gallery({ notify }: { notify: (message: string) => void }) {
  const [captures, setCaptures] = useState<Capture[]>([]);
  /** Selected capture names; the single-item actions use `selected`. */
  const [selection, setSelection] = useState<string[]>([]);
  /** Where a Shift+click range starts: the last plainly or Ctrl-clicked tile. */
  const [anchor, setAnchor] = useState<string | null>(null);
  const selected = selection.length === 1 ? selection[0] : null;
  const selectOnly = (name: string | null) => {
    setSelection(name ? [name] : []);
    setAnchor(name);
  };
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
      selectOnly(name);
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
    (names: string[]) =>
      names.length > 0 &&
      invoke("delete_captures", { names })
        .then(() => {
          setSelection((sel) => sel.filter((n) => !names.includes(n)));
          notify(names.length === 1 ? "Spostata nel cestino" : `${names.length} catture spostate nel cestino`);
          return refresh();
        })
        .catch((e) => notify(String(e))),
    [notify, refresh],
  );

  /** Where a left press on a tile started; moving past DRAG_START turns it into a file drag. */
  const press = useRef<{ name: string; x: number; y: number } | null>(null);

  useEffect(() => {
    const onMove = (e: globalThis.MouseEvent) => {
      const p = press.current;
      if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_START) return;
      press.current = null;
      // The whole selection when the tile is part of it, else just that tile.
      const names = selection.includes(p.name) ? selection : [p.name];
      if (!selection.includes(p.name)) selectOnly(p.name);
      invoke("drag_captures", { names }).catch((err) => notify(String(err)));
    };
    const onUp = () => (press.current = null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  });

  /** Click with Explorer-style modifiers: Ctrl toggles, Shift selects a range. */
  const clickTile = (name: string, e: MouseEvent) => {
    if (e.shiftKey && anchor) {
      const names = captures.map((c) => c.name);
      const [a, b] = [names.indexOf(anchor), names.indexOf(name)].sort((x, y) => x - y);
      if (a >= 0) {
        const range = names.slice(a, b + 1);
        setSelection((sel) => (e.ctrlKey || e.metaKey ? [...new Set([...sel, ...range])] : range));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      setSelection((sel) => (sel.includes(name) ? sel.filter((n) => n !== name) : [...sel, name]));
      setAnchor(name);
    } else selectOnly(name);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "Escape") win.hide();
      else if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelection(captures.map((c) => c.name));
      } else if (e.key === "Delete") remove(selection);
      if (!selected) return;
      if (e.key === "Enter") edit(selected);
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
      { label: "Elimina", onSelect: () => remove([name]), danger: true },
    ];
  };

  /** Context menu for a multiple selection: only what applies to all of them. */
  const multiActions = (names: string[]): MenuItem[] => [
    { label: `Elimina ${names.length} catture`, onSelect: () => remove(names), danger: true },
  ];

  return (
    <div className="gallery">
      <header className="titlebar" data-tauri-drag-region>
        <img src="/tray-icon.svg" alt="" className="titlebar-icon" data-tauri-drag-region />
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

      <div className="gallery-grid" onClick={() => selectOnly(null)}>
        {captures.length === 0 ? (
          <p className="empty">Nessuna cattura. Premi Stamp o usa il menu della tray icon.</p>
        ) : (
          captures.map((c) => (
            <figure
              key={c.name}
              className={selection.includes(c.name) ? "tile selected" : "tile"}
              onClick={(e) => {
                e.stopPropagation();
                clickTile(c.name, e);
              }}
              onDoubleClick={() => edit(c.name)}
              onMouseDown={(e) => {
                if (e.button === 0) press.current = { name: c.name, x: e.clientX, y: e.clientY };
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                if (!selection.includes(c.name)) selectOnly(c.name);
                setContext({ x: e.clientX, y: e.clientY, name: c.name });
              }}
            >
              <div className="tile-image">
                <img
                  src={`${convertFileSrc(c.name, "thumb")}?v=${c.modified_ms}`}
                  alt=""
                  loading="lazy"
                  draggable={false}
                />
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
          items={
            selection.length > 1 && selection.includes(context.name)
              ? multiActions(selection)
              : itemActions(context.name)
          }
          onClose={() => setContext(null)}
          style={{ position: "fixed", left: context.x, top: context.y }}
        />
      )}
    </div>
  );
}
