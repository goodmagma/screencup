import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ExternalLink, FileText } from "lucide-react";
import { t } from "./i18n";

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
      <p className="about-version">{t("about.version", { version: info?.version ?? "…" })}</p>
      <p className="about-tagline">{t("about.tagline")}</p>
      <div className="about-links">
        <button onClick={() => run("open_repository")} title={info?.repository}>
          <ExternalLink size={16} />
          <span>{t("about.github")}</span>
        </button>
        <button className="ghost" onClick={() => run("open_licenses")}>
          <FileText size={16} />
          <span>{t("about.licenses")}</span>
        </button>
      </div>
      <p className="about-legal">
        © 2026 goodmagma · {t("about.license")}
        <br />
        {t("about.ffmpeg")}
      </p>
    </div>
  );
}
