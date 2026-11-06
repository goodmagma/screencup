import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ExternalLink, FileText } from "lucide-react";

/** Mirrors `AboutInfo` in src-tauri/src/about.rs. */
interface AboutInfo {
  version: string;
  repository: string;
}

/** The "About" window opened from the tray menu or the gallery title bar. */
export function AboutWindow({ notify }: { notify: (message: string) => void }) {
  const [info, setInfo] = useState<AboutInfo | null>(null);

  useEffect(() => {
    invoke<AboutInfo>("about_info").then(setInfo).catch((e) => notify(String(e)));
  }, [notify]);

  const run = (command: string) => invoke(command).catch((e) => notify(String(e)));

  return (
    <div className="about">
      <img src="/app-icon.svg" alt="" className="about-icon" />
      <h1>Screencup</h1>
      <p className="about-version">Versione {info?.version ?? "…"}</p>
      <p className="about-tagline">Screenshot, annotazioni e registrazioni dello schermo.</p>
      <div className="about-links">
        <button onClick={() => run("open_repository")} title={info?.repository}>
          <ExternalLink size={16} />
          <span>Pagina GitHub</span>
        </button>
        <button className="ghost" onClick={() => run("open_licenses")}>
          <FileText size={16} />
          <span>Licenze</span>
        </button>
      </div>
      <p className="about-legal">
        © 2026 goodmagma · Licenza MIT
        <br />
        Include ffmpeg, distribuito con la propria licenza.
      </p>
    </div>
  );
}
