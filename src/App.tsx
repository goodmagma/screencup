import { useCallback, useRef, useState } from "react";
import { Editor } from "./editor/Editor";
import { Gallery } from "./Gallery";

export function App() {
  const [editing, setEditing] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2500);
  }, []);

  return (
    <div className="app">
      {editing ? (
        <Editor name={editing} onClose={() => setEditing(null)} notify={notify} />
      ) : (
        <Gallery onEdit={setEditing} notify={notify} />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
