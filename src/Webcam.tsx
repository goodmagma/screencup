import { useEffect, useRef, useState } from "react";
import { getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import { VideoOff } from "lucide-react";
import { t } from "./i18n";

const win = getCurrentWindow();
const MIN_SIZE = 80;
const MAX_SIZE = 480;
const STEP = 1.1;

/**
 * Round webcam overlay (see src-tauri/src/webcam.rs). The window is part of the screen grab,
 * so what shows here is recorded. Drag to move; mouse wheel to resize around the centre.
 */
export function Webcam() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.classList.add("clickfx");
    let stream: MediaStream | null = null;
    navigator.mediaDevices
      .getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 640 } }, audio: false })
      .then((s) => {
        stream = s;
        if (videoRef.current) videoRef.current.srcObject = s;
      })
      .catch((e) => setError(String(e?.message ?? e)));
    return () => stream?.getTracks().forEach((track) => track.stop());
  }, []);

  const onWheel = async (e: React.WheelEvent) => {
    const factor = e.deltaY < 0 ? STEP : 1 / STEP;
    const scale = await win.scaleFactor();
    const size = (await win.innerSize()).toLogical(scale);
    const pos = (await win.outerPosition()).toLogical(scale);
    const next = Math.round(Math.min(MAX_SIZE, Math.max(MIN_SIZE, size.width * factor)));
    const shift = (size.width - next) / 2;
    await win.setSize(new LogicalSize(next, next));
    await win.setPosition(new LogicalPosition(pos.x + shift, pos.y + shift));
  };

  return (
    <div
      className="webcam"
      onMouseDown={(e) => e.button === 0 && win.startDragging()}
      onWheel={onWheel}
      title={error ?? undefined}
    >
      {error ? (
        <div className="webcam-error">
          <VideoOff size={28} />
          <span>{t("webcam.unavailable")}</span>
        </div>
      ) : (
        <video ref={videoRef} autoPlay muted playsInline />
      )}
    </div>
  );
}
