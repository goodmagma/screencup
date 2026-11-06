import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, ExternalLink, FileText, RefreshCw } from "lucide-react";
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

  /** Result of "Check for updates": null before, "none" when up to date. */
  const [found, setFound] = useState<{ version: string } | "none" | "checking" | null>(null);
  const check = () => {
    setFound("checking");
    invoke<{ version: string } | null>("check_update")
      .then((u) => setFound(u ?? "none"))
      .catch((e) => {
        // Usually no network, or no release info published yet: the raw text is technical.
        console.warn("update check:", e);
        setFound(null);
        notify(t("update.unreachable"));
      });
  };
  const install = () => {
    notify(t("update.downloading"));
    invoke("install_update").catch((e) => notify(t("update.failed", { error: String(e) })));
  };

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
      <div className="about-update">
        {found && typeof found === "object" ? (
          <button onClick={install}>
            <Download size={16} />
            <span>{t("update.installVersion", { version: found.version })}</span>
          </button>
        ) : (
          <button className="ghost" onClick={check} disabled={found === "checking"}>
            <RefreshCw size={16} />
            <span>{found === "checking" ? t("update.checking") : t("update.check")}</span>
          </button>
        )}
        {found === "none" && <p className="about-version">{t("update.upToDate")}</p>}
      </div>
      <p className="about-legal">
        © 2026 goodmagma · {t("about.license")}
        <br />
        {t("about.ffmpeg")}
      </p>
    </div>
  );
}
