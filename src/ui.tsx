import { type ReactNode, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { t } from "./i18n";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Shows a check mark: the item is an on/off toggle. */
  checked?: boolean;
}

/** A floating list of actions; closes on outside click or Escape. */
export function Menu({
  items,
  onClose,
  style,
  className,
}: {
  items: MenuItem[];
  onClose: () => void;
  style?: React.CSSProperties;
  className?: string;
}) {
  const ref = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // Deferred so the click that opened the menu does not close it.
    const t = window.setTimeout(() => window.addEventListener("mousedown", onDown));
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <ul ref={ref} className={`menu ${className ?? ""}`} style={style} onContextMenu={(e) => e.preventDefault()}>
      {items.map((item) => (
        <li key={item.label}>
          <button
            disabled={item.disabled}
            className={item.danger ? "danger" : undefined}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.checked !== undefined && <span className="check">{item.checked ? "✓" : ""}</span>}
            {item.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Large round action of the gallery bar, with an optional drop-down of related actions. */
export function BigButton({
  icon,
  label,
  ring,
  onClick,
  menu,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  ring: string;
  onClick: () => void;
  menu?: MenuItem[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="big-action">
      <button className="big-button" onClick={onClick} disabled={disabled}>
        <span className="ring" style={{ borderColor: ring }}>
          {icon}
        </span>
        <span className="big-label">{label}</span>
      </button>
      {menu && (
        <button className="caret" onClick={() => setOpen(!open)} title={t("common.moreOptions")}>
          <ChevronDown size={16} strokeWidth={3} />
        </button>
      )}
      {open && menu && <Menu items={menu} onClose={() => setOpen(false)} className="menu-up" />}
    </div>
  );
}

/** Icon-over-label button of the editor ribbon. */
export function RibbonButton({
  icon,
  label,
  onClick,
  disabled,
  title,
  tint,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  tint?: string;
}) {
  return (
    <button className="ribbon-button" onClick={onClick} disabled={disabled} title={title}>
      <span className="ribbon-icon" style={tint ? { background: tint } : undefined}>
        {icon}
      </span>
      <span>{label}</span>
    </button>
  );
}
