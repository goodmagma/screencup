import { useCallback, useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { Camera, CloudUpload, Maximize2, Minus, PencilRuler, Video, X } from "lucide-react";
import { BigButton, Menu, type MenuItem } from "./ui";

/** Mirrors `Capture` in src-tauri/src/library.rs. */
interface Capture {
  path: string;
  name: string;
  modified_ms: number;
}

/** Mirrors `CaptureKind` in src-tauri/src/capture.rs. */
type CaptureKind = "region" | "screen" | "all";

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const win = getCurrentWindow();

export function Gallery({ notify }: { notify: (message: string) => void }) {
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [context, setContext] = useState<{ x: number; y: number; name: string } | null>(null);

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
      setSelected(baseName(event.payload));
      notify("Catturata e copiata negli appunti");
    });
    const updated = listen("capture-updated", refresh);
    return () => {
      added.then((off) => off());
      updated.then((off) => off());
    };
  }, [refresh, notify]);

  const capture = (kind: CaptureKind) => invoke("capture", { kind });
  const edit = (name: string) => invoke("open_editor", { name }).catch((e) => notify(String(e)));
  const pathOf = (name: string) => captures.find((c) => c.name === name)?.path;

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
    const path = pathOf(name);
    return [
      { label: "Modifica", onSelect: () => edit(name) },
      { label: "Copia negli appunti", onSelect: () => copy(name) },
      { label: "Apri con l'app predefinita", onSelect: () => path && openPath(path) },
      { label: "Mostra nella cartella", onSelect: () => path && revealItemInDir(path) },
      { label: "Elimina", onSelect: () => remove(name), danger: true },
    ];
  };

  const soon = (what: string) => () => notify(`${what}: in arrivo`);

  return (
    <div className="gallery">
      <header className="titlebar" data-tauri-drag-region>
        <img src="/app-icon.svg" alt="" className="titlebar-icon" data-tauri-drag-region />
        <span data-tauri-drag-region>Screencup</span>
        <div className="titlebar-buttons">
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
          onClick={soon("Registrazione video")}
          menu={[
            { label: "Registra una regione", onSelect: soon("Registrazione video") },
            { label: "Registra lo schermo", onSelect: soon("Registrazione video") },
          ]}
        />
        <BigButton
          icon={<PencilRuler size={26} />}
          label="Modifica..."
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
                  { label: "Mostra nella cartella", onSelect: () => revealItemInDir(pathOf(selected)!) },
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
