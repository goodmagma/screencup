import { useCallback, useRef, useState } from "react";
import { EditorWindow } from "./editor/Editor";
import { Gallery } from "./Gallery";
import { RecBar } from "./RecBar";

declare global {
  interface Window {
    /** Set by `open_editor` in src-tauri/src/lib.rs on editor windows only. */
    __SCREENCUP_EDIT__?: string;
    /** Set by `open_bar` in src-tauri/src/recorder.rs on the recording control bar. */
    __SCREENCUP_RECBAR__?: { startedMs: number };
  }
}

/** Editor windows carry the capture name; the main window is the gallery. */
const editName = window.__SCREENCUP_EDIT__ ?? null;

export function App() {
  const recbar = window.__SCREENCUP_RECBAR__;
  if (recbar) return <RecBar startedMs={recbar.startedMs} />;
  return <MainWindow />;
}

function MainWindow() {
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2500);
  }, []);

  return (
    <div className="app">
      {editName ? <EditorWindow name={editName} notify={notify} /> : <Gallery notify={notify} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
