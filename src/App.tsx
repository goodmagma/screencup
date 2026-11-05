import { useCallback, useRef, useState } from "react";
import { EditorWindow } from "./editor/Editor";
import { Gallery } from "./Gallery";
import { ClickFx } from "./ClickFx";
import { RecBar } from "./RecBar";
import { SettingsWindow } from "./Settings";

declare global {
  interface Window {
    /** Set by `open_editor` in src-tauri/src/lib.rs on editor windows only. */
    __SCREENCUP_EDIT__?: string;
    /** Set by `open_bar` in src-tauri/src/recorder.rs on the recording control bar. */
    __SCREENCUP_RECBAR__?: { startedMs: number; mic: boolean; system: boolean };
    /** Set by `settings::show` in src-tauri/src/settings.rs on the settings window. */
    __SCREENCUP_SETTINGS__?: boolean;
    /** Set by `ClickFx::start` in src-tauri/src/clickfx.rs on the click highlight window. */
    __SCREENCUP_CLICKFX__?: boolean;
  }
}

/** Editor windows carry the capture name; the main window is the gallery. */
const editName = window.__SCREENCUP_EDIT__ ?? null;

export function App() {
  const recbar = window.__SCREENCUP_RECBAR__;
  if (recbar) return <RecBar {...recbar} />;
  if (window.__SCREENCUP_CLICKFX__) return <ClickFx />;
  return <MainWindow />;
}

function MainWindow() {
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    // Errors and warnings stay longer: they may arrive while the window is still appearing.
    const ms = /non riuscita|Audio:/.test(message) ? 7000 : 2500;
    toastTimer.current = window.setTimeout(() => setToast(null), ms);
  }, []);

  return (
    <div className="app">
      {editName ? (
        <EditorWindow name={editName} notify={notify} />
      ) : window.__SCREENCUP_SETTINGS__ ? (
        <SettingsWindow notify={notify} />
      ) : (
        <Gallery notify={notify} />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
