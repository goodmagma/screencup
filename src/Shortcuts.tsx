import { useEffect } from "react";
import { type Key, t } from "./i18n";
import { HOTKEY_ROWS, type Hotkeys, formatAccelerator } from "./Settings";
import { TOOLS } from "./editor/model";

/** A row: the keys (an accelerator such as `Control+KeyA`, or a translated key name), then what it does. */
type Row = [keys: string, action: string];

const acc = formatAccelerator;
const k = (key: Key) => t(key);
const withMod = (accelerator: string, key: Key) => `${acc(accelerator)} + ${t(key)}`;

/** Keyboard and mouse shortcuts of every window, grouped by where they apply. */
function sections(hotkeys: Hotkeys | undefined): { title: string; hint?: string; rows: Row[] }[] {
  return [
    {
      title: t("shortcuts.global"),
      hint: t("shortcuts.globalHint"),
      rows: HOTKEY_ROWS.map(({ key, label }) => [
        hotkeys?.[key] ? acc(hotkeys[key]) : t("settings.hkNone"),
        t(label),
      ]),
    },
    {
      title: t("shortcuts.capture"),
      rows: [
        [k("key.Drag"), t("sc.selectRegion")],
        [k("key.Click"), t("sc.captureHover")],
        [k("key.Wheel"), t("sc.snapDepth")],
        [k("key.Arrows"), t("sc.nudge1")],
        [`${acc("Shift")} + ${t("key.Arrows")}`, t("sc.nudge10")],
        ["C", t("sc.pickColor")],
        [k("key.RightClick"), t("sc.rightClick")],
        [acc("Escape"), t("common.cancel")],
      ],
    },
    {
      title: t("shortcuts.gallery"),
      rows: [
        [acc("Control+KeyA"), t("sc.selectAll")],
        [withMod("Control", "key.Click"), t("sc.multiSelect")],
        [withMod("Shift", "key.Click"), t("sc.rangeSelect")],
        [k("key.Enter"), t("sc.edit")],
        [acc("Control+KeyC"), t("common.copyToClipboard")],
        [acc("Control+KeyV"), t("sc.paste")],
        [k("key.Delete"), t("sc.delete")],
        ["F1", t("sc.help")],
        [acc("Escape"), t("sc.hide")],
      ],
    },
    {
      title: t("shortcuts.editor"),
      rows: [
        [acc("Control+KeyZ"), t("sc.undo")],
        [`${acc("Control+Shift+KeyZ")}, ${acc("Control+KeyY")}`, t("sc.redo")],
        [acc("Control+KeyS"), t("sc.save")],
        [acc("Control+KeyC"), t("sc.copyImage")],
        [acc("Control+KeyV"), t("sc.pasteImage")],
        [k("key.Delete"), t("sc.removeShape")],
        [acc("Escape"), t("sc.deselect")],
        [k("key.Enter"), t("sc.finishPolygon")],
        [withMod("Shift", "key.Drag"), t("sc.square")],
        [withMod("Control", "key.Wheel"), t("sc.zoom")],
        ...TOOLS.map(({ tool, key }): Row => [key.toUpperCase(), t(`tool.${tool}` as Key)]),
      ],
    },
    {
      title: t("shortcuts.video"),
      rows: [
        [t("key.Space"), t("sc.playPause")],
        ["I", t("video.setStart")],
        ["O", t("video.setEnd")],
        [acc("Escape"), t("common.close")],
      ],
    },
  ];
}

export function Shortcuts({ hotkeys, onClose }: { hotkeys: Hotkeys | undefined; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "F1") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    // Capture phase, so Esc closes this dialog instead of hiding the gallery.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="modal-backdrop" style={{ position: "fixed" }} onClick={onClose}>
      <div className="modal shortcuts-modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t("shortcuts.title")}</h3>
        <div className="shortcuts-body">
          {sections(hotkeys).map((s) => (
            <section key={s.title}>
              <h4>
                {s.title}
                {s.hint && <span className="shortcuts-hint"> · {s.hint}</span>}
              </h4>
              <dl>
                {s.rows.map(([keys, action]) => (
                  <div key={keys + action}>
                    <dt>
                      <kbd>{keys}</kbd>
                    </dt>
                    <dd>{action}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <div className="modal-buttons">
          <button onClick={onClose}>{t("common.close")}</button>
        </div>
      </div>
    </div>
  );
}
