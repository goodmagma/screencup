import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

/** Mirrors `Click` in src-tauri/src/clickfx.rs: physical pixels from the area's top-left. */
interface Click {
  x: number;
  y: number;
  button: "left" | "right";
}

/** Matches the `ripple` animation in src/styles.css. */
const RIPPLE_MS = 600;

/** Transparent, click-through window over the recorded area; ripples where clicks land. */
export function ClickFx() {
  const [ripples, setRipples] = useState<(Click & { id: number })[]>([]);

  useEffect(() => {
    document.documentElement.classList.add("clickfx");
    let next = 0;
    const off = listen<Click>("click-fx", ({ payload }) => {
      const id = next++;
      setRipples((r) => [...r, { ...payload, id }]);
      window.setTimeout(() => setRipples((r) => r.filter((x) => x.id !== id)), RIPPLE_MS);
    });
    return () => {
      off.then((f) => f());
    };
  }, []);

  const dpr = window.devicePixelRatio || 1;
  return (
    <>
      {ripples.map((r) => (
        <span key={r.id} className={`ripple ${r.button}`} style={{ left: r.x / dpr, top: r.y / dpr }} />
      ))}
    </>
  );
}
