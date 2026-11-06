import { type ReactNode, useEffect, useRef, useState } from "react";
import { ChevronLeft, Clock, Copy, Link2, Mail } from "lucide-react";
import { language, t } from "./i18n";

/** Mirrors `Share` in src-tauri/src/share.rs. */
export interface Share {
  name: string;
  url: string;
  service: "litterbox" | "catbox";
  uploaded_ms: number;
  expires_ms: number | null;
}

function Row({
  icon,
  title,
  detail,
  onClick,
  disabled,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button className="share-row" onClick={onClick} disabled={disabled}>
      <span className="share-row-icon">{icon}</span>
      <span className="share-row-text">
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
    </button>
  );
}

/**
 * Pop-up of the Share button, as in Screenpresso: one row per way of sharing, plus the
 * settings and the history of shared links. Nothing happens until a row is picked.
 */
export function SharePanel({
  count,
  hours,
  shares,
  onTemporary,
  onPermanent,
  onEmail,
  onCopy,
  onSettings,
  onClose,
}: {
  /** Selected captures; the share rows need at least one. */
  count: number;
  hours: number;
  shares: Share[];
  onTemporary: () => void;
  onPermanent: () => void;
  onEmail: () => void;
  onCopy: (url: string) => void;
  onSettings: () => void;
  onClose: () => void;
}) {
  const [history, setHistory] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Closes on a click outside (the Share button toggles it itself) or on Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || ref.current?.parentElement?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const act = (f: () => void) => () => {
    f();
    onClose();
  };
  const none = count === 0;
  const date = (ms: number) =>
    new Date(ms).toLocaleString(language(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="share-panel" ref={ref}>
      {history ? (
        <>
          <button className="share-back" onClick={() => setHistory(false)}>
            <ChevronLeft size={16} />
            <span>{t("share.back")}</span>
          </button>
          <div className="share-history">
            {shares.length === 0 && <p className="share-empty">{t("share.noHistory")}</p>}
            {shares.map((s) => (
              <button key={s.url} className="share-link" onClick={() => onCopy(s.url)} title={t("share.copyLink")}>
                <span className="share-link-text">
                  <strong>{s.name}</strong>
                  <small>
                    {s.url} ·{" "}
                    {s.expires_ms ? t("share.expires", { date: date(s.expires_ms) }) : t("share.permanentShort")}
                  </small>
                </span>
                <Copy size={14} />
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          {none && <p className="share-hint">{t("share.selectFirst")}</p>}
          <Row
            icon={<Clock size={22} />}
            title={t("share.temporary", { hours })}
            detail={t("share.temporaryDetail", { hours })}
            onClick={act(onTemporary)}
            disabled={none}
          />
          <Row
            icon={<Link2 size={22} />}
            title={t("share.permanent")}
            detail={t("share.permanentDetail")}
            onClick={act(onPermanent)}
            disabled={none}
          />
          <Row
            icon={<Mail size={22} />}
            title={t("share.email")}
            detail={t("share.emailDetail")}
            onClick={act(onEmail)}
            disabled={none}
          />
          <div className="share-footer">
            <button className="link-button" onClick={act(onSettings)}>
              {t("common.settings")}
            </button>
            <button className="link-button" onClick={() => setHistory(true)}>
              {t("share.history")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
