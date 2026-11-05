import { useCallback, useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";

/** Mirrors `Capture` in src-tauri/src/library.rs. */
interface Capture {
  path: string;
  name: string;
  modified_ms: number;
}

/** Mirrors `CaptureKind` in src-tauri/src/capture.rs. */
type CaptureKind = "region" | "screen" | "all";

interface Props {
  onEdit: (name: string) => void;
  notify: (message: string) => void;
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

export function Gallery({ onEdit, notify }: Props) {
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

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
      notify("Captured and copied to clipboard");
    });
    const updated = listen("capture-updated", refresh);
    return () => {
      added.then((off) => off());
      updated.then((off) => off());
    };
  }, [refresh, notify]);

  const capture = (kind: CaptureKind) => invoke("capture", { kind });

  const copy = useCallback(
    (name: string) =>
      invoke("copy_capture", { name })
        .then(() => notify("Copied to clipboard"))
        .catch((e) => notify(String(e))),
    [notify],
  );

  const remove = useCallback(
    (name: string) =>
      invoke("delete_capture", { name })
        .then(() => {
          setSelected((s) => (s === name ? null : s));
          notify("Moved to trash");
          return refresh();
        })
        .catch((e) => notify(String(e))),
    [notify, refresh],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selected) return;
      if (e.key === "Delete") remove(selected);
      else if (e.key === "Enter") onEdit(selected);
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") copy(selected);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, copy, remove, onEdit]);

  return (
    <>
      <header className="toolbar">
        <h1>Screencup</h1>
        <button onClick={() => capture("region")} title="PrintScreen">
          Region
        </button>
        <button onClick={() => capture("screen")} title="Shift+PrintScreen">
          Screen
        </button>
        <button onClick={() => capture("all")}>All screens</button>
      </header>
      {captures.length === 0 ? (
        <p className="empty">No captures yet. Press PrintScreen or use the tray menu.</p>
      ) : (
        <ul className="grid" onClick={() => setSelected(null)}>
          {captures.map((c) => (
            <li
              key={c.name}
              className={c.name === selected ? "selected" : undefined}
              title={c.name}
              onClick={(e) => {
                e.stopPropagation();
                setSelected(c.name);
              }}
              onDoubleClick={() => onEdit(c.name)}
            >
              <img src={`${convertFileSrc(c.name, "thumb")}?v=${c.modified_ms}`} alt={c.name} loading="lazy" />
              <div className="meta">
                <span>{new Date(c.modified_ms).toLocaleString()}</span>
                <div className="actions" onDoubleClick={(e) => e.stopPropagation()}>
                  <button className="ghost" onClick={() => onEdit(c.name)} title="Edit (Enter)">
                    Edit
                  </button>
                  <button className="ghost" onClick={() => copy(c.name)} title="Copy (Ctrl+C)">
                    Copy
                  </button>
                  <button className="ghost" onClick={() => openPath(c.path)} title="Open in the default app">
                    Open
                  </button>
                  <button className="ghost" onClick={() => revealItemInDir(c.path)} title="Show in folder">
                    Folder
                  </button>
                  <button className="ghost danger" onClick={() => remove(c.name)} title="Move to trash (Delete)">
                    Delete
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
