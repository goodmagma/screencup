import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Square, X } from "lucide-react";

const pad = (n: number) => String(n).padStart(2, "0");

/** Floating control bar shown while recording; see `open_bar` in src-tauri/src/recorder.rs. */
export function RecBar({ startedMs }: { startedMs: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.floor((now - startedMs) / 1000));
  const time = `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}`;

  return (
    <div className="recbar" data-tauri-drag-region>
      <span className="rec-dot" data-tauri-drag-region />
      <span className="rec-time" data-tauri-drag-region>
        {time}
      </span>
      <button className="rec-stop" onClick={() => invoke("stop_recording")} title="Ferma e salva (Ctrl+Stamp)">
        <Square size={14} fill="currentColor" /> Stop
      </button>
      <button className="rec-cancel" onClick={() => invoke("cancel_recording")} title="Annulla la registrazione">
        <X size={16} />
      </button>
    </div>
  );
}
