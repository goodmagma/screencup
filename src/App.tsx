import { useCallback, useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openPath } from "@tauri-apps/plugin-opener";

/** Mirrors `Capture` in src-tauri/src/lib.rs. */
interface Capture {
  path: string;
  name: string;
  modified_ms: number;
}

export function App() {
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    invoke<Capture[]>("list_captures")
      .then((list) => {
        setCaptures(list);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    refresh();
    const unlisten = listen("capture-added", refresh);
    return () => {
      unlisten.then((off) => off());
    };
  }, [refresh]);

  return (
    <div className="app">
      <header className="toolbar">
        <h1>Screencup</h1>
        <button onClick={() => invoke("capture_region")}>Capture region</button>
      </header>
      {error && <p className="error">{error}</p>}
      {captures.length === 0 ? (
        <p className="empty">No captures yet. Use the tray menu or press PrintScreen.</p>
      ) : (
        <ul className="grid">
          {captures.map((c) => (
            <li key={c.path} title={c.name} onDoubleClick={() => openPath(c.path)}>
              <img src={convertFileSrc(c.path)} alt={c.name} loading="lazy" />
              <span>{new Date(c.modified_ms).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
