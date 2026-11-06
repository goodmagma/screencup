import { type MouseEvent, useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Camera, CloudUpload, ImageDown, Info, Link2, Maximize2, Minus, PencilRuler, Play, Settings, Video, X } from "lucide-react";
import { formatAccelerator, patchSettings, type SettingsData } from "./Settings";
import { t } from "./i18n";
import { BigButton, Menu, type MenuItem } from "./ui";
import { type Share, SharePanel } from "./SharePanel";

/** Mirrors `Capture` in src-tauri/src/library.rs. */
interface Capture {
  path: string;
  name: string;
  modified_ms: number;
  video: boolean;
}

/** Mirrors `Service` in src-tauri/src/share.rs. */
type Service = "litterbox" | "catbox";


const HOSTS: Record<Service, string> = { litterbox: "litterbox.catbox.moe", catbox: "catbox.moe" };

/** Mirrors `CaptureKind` in src-tauri/src/capture.rs. */
type CaptureKind = "region" | "screen" | "all";

/** Mirrors `RecordKind` in src-tauri/src/recorder.rs. */
type RecordKind = "region" | "screen";

/** Pointer travel, in CSS pixels, before a press on a tile starts dragging it out. */
const DRAG_START = 6;

/** "Open with…" uses a Windows dialog; see `open_capture_with` in src-tauri/src/library.rs. */
const IS_WINDOWS = navigator.userAgent.includes("Windows");

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const win = getCurrentWindow();

/** Hotkey shown after a menu label, e.g. " (Shift + PrtSc)"; nothing when unset. */
const hotkeyHint = (acc?: string) => (acc ? ` (${formatAccelerator(acc)})` : "");

export function Gallery({ notify }: { notify: (message: string, long?: boolean) => void }) {
  const [captures, setCaptures] = useState<Capture[]>([]);
  /** Selected capture names; the single-item actions use `selected`. */
  const [selection, setSelection] = useState<string[]>([]);
  /** Where a Shift+click range starts: the last plainly or Ctrl-clicked tile. */
  const [anchor, setAnchor] = useState<string | null>(null);
  const selected = selection.length === 1 ? selection[0] : null;
  const selectOnly = (name: string | null) => {
    setSelection(name ? [name] : []);
    setAnchor(name);
  };
  const [context, setContext] = useState<{ x: number; y: number; name: string } | null>(null);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  /** Files dragged over the window; see `import_captures` in src-tauri/src/library.rs. */
  const [dropping, setDropping] = useState(false);
  const importing = useRef(false);
  const libraryPaths = useRef(new Set<string>());
  libraryPaths.current = new Set(captures.map((c) => c.path));

  const importFiles = (paths: string[]) => {
    importing.current = true;
    invoke<string[]>("import_captures", { paths })
      .then((files) =>
        notify(
          files.length === 0
            ? t("import.none")
            : files.length === 1
              ? t("import.one")
              : t("import.many", { count: files.length }),
        ),
      )
      .catch((e) => notify(t("import.failed", { error: String(e) }), true))
      .finally(() => {
        importing.current = false;
      });
  };

  useEffect(() => {
    const off = getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "enter") {
        // Captures dragged out of this gallery and back are not an import.
        setDropping(p.paths.some((path) => !libraryPaths.current.has(path)));
      } else if (p.type === "leave") setDropping(false);
      else if (p.type === "drop") {
        setDropping(false);
        const outside = p.paths.filter((path) => !libraryPaths.current.has(path));
        if (outside.length) importFiles(outside);
      }
    });
    return () => {
      off.then((f) => f());
    };
  }, []);

  /** Newer version found by the background check (src-tauri/src/updater.rs). */
  const [update, setUpdate] = useState<{ version: string } | null>(null);
  const [updating, setUpdating] = useState(false);
  useEffect(() => {
    const off = listen<{ version: string }>("update-available", (e) => setUpdate(e.payload));
    return () => {
      off.then((f) => f());
    };
  }, []);
  const installUpdate = () => {
    setUpdating(true);
    notify(t("update.downloading"));
    invoke("install_update").catch((e) => {
      setUpdating(false);
      notify(t("update.failed", { error: String(e) }), true);
    });
  };

  /** Live shared links, newest first. */
  const [shares, setShares] = useState<Share[]>([]);
  /** Upload waiting for the one-time "links are public" confirmation. */
  const [askShare, setAskShare] = useState<{ names: string[]; service: Service } | null>(null);
  const [dontAsk, setDontAsk] = useState(false);
  const [uploading, setUploading] = useState(false);

  const refreshShares = useCallback(() => invoke<Share[]>("list_shares").then(setShares).catch(() => {}), []);
  useEffect(() => {
    refreshShares();
  }, [refreshShares]);

  /** Newest live link of a capture, if any. */
  const linkOf = (name: string) => shares.find((s) => s.name === name)?.url;

  const copyLinks = (urls: string[]) =>
    invoke("copy_text", { text: urls.join("\n") })
      .then(() => notify(urls.length === 1 ? t("share.copied") : t("share.copiedMany", { count: urls.length })))
      .catch((e) => notify(String(e), true));

  /** Uploads one by one, then copies every link obtained. */
  const upload = async (names: string[], service: Service) => {
    setUploading(true);
    notify(t("share.uploading"));
    const urls: string[] = [];
    try {
      for (const name of names) {
        try {
          urls.push((await invoke<Share>("share_capture", { name, service })).url);
        } catch (e) {
          notify(t("share.failed", { error: String(e) }), true);
        }
      }
    } finally {
      setUploading(false);
      refreshShares();
    }
    if (urls.length) await copyLinks(urls);
  };

  /** Asks once that links are public, then uploads. */
  const share = (names: string[], service: Service) => {
    if (names.length === 0 || uploading) return;
    if (settings?.share_confirmed) upload(names, service);
    else {
      setDontAsk(false);
      setAskShare({ names, service });
    }
  };

  const confirmShare = () => {
    if (!askShare) return;
    if (dontAsk) patchSettings({ share_confirmed: true }).catch((e) => notify(String(e)));
    upload(askShare.names, askShare.service);
    setAskShare(null);
  };

  const [sharePanel, setSharePanel] = useState(false);
  const closeSharePanel = useCallback(() => setSharePanel(false), []);

  /** Opens a new message in the mail client with the captures attached. */
  const email = (names: string[]) =>
    invoke<"attached" | "manual">("email_captures", { names })
      .then((how) => how === "manual" && notify(t("share.emailManual"), true))
      .catch((e) => notify(String(e), true));

  const hours = settings?.share_expiry_hours ?? 24;
  /** Share entries for menus: both hosts, plus the existing link when there is one. */
  const shareActions = (names: string[]): MenuItem[] => {
    const link = names.length === 1 ? linkOf(names[0]) : undefined;
    return [
      { label: t("share.temporary", { hours }), onSelect: () => share(names, "litterbox"), disabled: uploading },
      { label: t("share.permanent"), onSelect: () => share(names, "catbox"), disabled: uploading },
      { label: t("share.email"), onSelect: () => email(names) },
      ...(link ? [{ label: t("share.copyLink"), onSelect: () => copyLinks([link]) }] : []),
    ];
  };

  useEffect(() => {
    invoke<SettingsData>("get_settings").then(setSettings).catch((e) => notify(String(e)));
    const off = listen<SettingsData>("settings-changed", (e) => setSettings(e.payload));
    return () => {
      off.then((f) => f());
    };
  }, [notify]);

  const updateSettings = (patch: Partial<SettingsData>) => patchSettings(patch).catch((e) => notify(String(e)));

  const refresh = useCallback(
    () =>
      invoke<Capture[]>("list_captures")
        .then(setCaptures)
        .catch((e) => notify(String(e))),
    [notify],
  );

  useEffect(() => {
    refresh();
    const added = listen<string>("capture-added", (event) => {
      refresh();
      const name = baseName(event.payload);
      selectOnly(name);
      // Imports report once, with their count.
      if (importing.current) return;
      notify(name.endsWith(".mp4") ? t("gallery.recordingSaved") : t("gallery.captured"));
    });
    const updated = listen("capture-updated", refresh);
    const failed = listen<string>("recording-error", (event) => notify(t("gallery.recordingFailed", { error: event.payload }), true));
    const warned = listen<string>("recording-warning", (event) => notify(t("gallery.audioWarning", { warning: event.payload }), true));
    return () => {
      added.then((off) => off());
      updated.then((off) => off());
      failed.then((off) => off());
      warned.then((off) => off());
    };
  }, [refresh, notify]);

  const capture = (kind: CaptureKind) => invoke("capture", { kind });
  const record = (kind: RecordKind) => invoke("toggle_recording", { kind });
  const isVideo = (name: string) => captures.find((c) => c.name === name)?.video ?? false;
  const open = (name: string) => invoke("open_capture", { name }).catch((e) => notify(String(e)));
  /** Text recognition; the text goes to the clipboard. */
  const copyText = (name: string) =>
    invoke<string>("ocr_capture", { name })
      .then((text) => notify(text ? t("ocr.copied", { count: text.length }) : t("ocr.none")))
      .catch((e) => notify(t("ocr.failed", { error: String(e) }), true));
  const openWith = (name: string) => invoke("open_capture_with", { name }).catch((e) => notify(String(e)));
  const saveAs = (name: string) =>
    invoke<string | null>("export_capture", { name })
      .then((path) => path && notify(t("editor.exported", { path })))
      .catch((e) => notify(String(e), true));
  const reveal = (name: string) => invoke("reveal_capture", { name }).catch((e) => notify(String(e)));
  /** Images open in the editor; videos in the system player. */
  /** Images open in the image editor; recordings in the video editor (trim, GIF). */
  const edit = (name: string) =>
    invoke(isVideo(name) ? "open_video_editor" : "open_editor", { name }).catch((e) => notify(String(e)));

  const copy = useCallback(
    (name: string) =>
      invoke("copy_capture", { name })
        .then(() => notify(t("common.copied")))
        .catch((e) => notify(String(e))),
    [notify],
  );

  const remove = useCallback(
    (names: string[]) =>
      names.length > 0 &&
      invoke("delete_captures", { names })
        .then(() => {
          setSelection((sel) => sel.filter((n) => !names.includes(n)));
          notify(names.length === 1 ? t("gallery.trashedOne") : t("gallery.trashedMany", { count: names.length }));
          return refresh();
        })
        .catch((e) => notify(String(e))),
    [notify, refresh],
  );

  /** Where a left press on a tile started; moving past DRAG_START turns it into a file drag. */
  const press = useRef<{ name: string; x: number; y: number } | null>(null);

  useEffect(() => {
    const onMove = (e: globalThis.MouseEvent) => {
      const p = press.current;
      if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_START) return;
      press.current = null;
      // The whole selection when the tile is part of it, else just that tile.
      const names = selection.includes(p.name) ? selection : [p.name];
      if (!selection.includes(p.name)) selectOnly(p.name);
      invoke("drag_captures", { names }).catch((err) => notify(String(err)));
    };
    const onUp = () => (press.current = null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  });

  /** Click with Explorer-style modifiers: Ctrl toggles, Shift selects a range. */
  const clickTile = (name: string, e: MouseEvent) => {
    if (e.shiftKey && anchor) {
      const names = captures.map((c) => c.name);
      const [a, b] = [names.indexOf(anchor), names.indexOf(name)].sort((x, y) => x - y);
      if (a >= 0) {
        const range = names.slice(a, b + 1);
        setSelection((sel) => (e.ctrlKey || e.metaKey ? [...new Set([...sel, ...range])] : range));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      setSelection((sel) => (sel.includes(name) ? sel.filter((n) => n !== name) : [...sel, name]));
      setAnchor(name);
    } else selectOnly(name);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "Escape") win.hide();
      else if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelection(captures.map((c) => c.name));
      } else if (e.key === "Delete") remove(selection);
      if (!selected) return;
      if (e.key === "Enter") edit(selected);
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") copy(selected);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const itemActions = (name: string): MenuItem[] => {
    const video = isVideo(name);
    return [
      { label: t("gallery.edit"), onSelect: () => edit(name) },
      ...(video ? [{ label: t("gallery.play"), onSelect: () => open(name) }] : []),
      { label: t("common.copyToClipboard"), onSelect: () => copy(name), disabled: video },
      ...(IS_WINDOWS ? [{ label: t("ocr.copyText"), onSelect: () => copyText(name), disabled: video }] : []),
      { label: t("gallery.openDefault"), onSelect: () => open(name) },
      ...(IS_WINDOWS ? [{ label: t("gallery.openWith"), onSelect: () => openWith(name) }] : []),
      { label: t("gallery.saveAs"), onSelect: () => saveAs(name), disabled: video },
      { label: t("gallery.reveal"), onSelect: () => reveal(name) },
      ...shareActions([name]),
      { label: t("common.delete"), onSelect: () => remove([name]), danger: true },
    ];
  };

  /** Context menu for a multiple selection: only what applies to all of them. */
  const multiActions = (names: string[]): MenuItem[] => [
    ...shareActions(names),
    { label: t("gallery.deleteMany", { count: names.length }), onSelect: () => remove(names), danger: true },
  ];

  return (
    <div className="gallery">
      {dropping && (
        <div className="drop-overlay">
          <ImageDown size={44} />
          <span>{t("import.drop")}</span>
        </div>
      )}
      <header className="titlebar" data-tauri-drag-region>
        <img src="/app-icon.svg" alt="" className="titlebar-icon" data-tauri-drag-region />
        <span data-tauri-drag-region>Screencup</span>
        <div className="titlebar-buttons">
          <button onClick={() => invoke("open_about")} title={t("gallery.about")}>
            <Info size={15} />
          </button>
          <button onClick={() => invoke("open_settings")} title={t("common.settings")}>
            <Settings size={15} />
          </button>
          <button onClick={() => win.minimize()} title={t("common.minimize")}>
            <Minus size={16} />
          </button>
          <button onClick={() => win.toggleMaximize()} title={t("common.maximize")}>
            <Maximize2 size={14} />
          </button>
          <button onClick={() => win.hide()} title={t("gallery.closeEsc")}>
            <X size={16} />
          </button>
        </div>
      </header>

      {update && (
        <div className="update-banner">
          <span>{t("update.available", { version: update.version })}</span>
          <button onClick={installUpdate} disabled={updating}>
            {t("update.install")}
          </button>
          <button className="ghost icon" onClick={() => setUpdate(null)} title={t("common.close")}>
            <X size={14} />
          </button>
        </div>
      )}

      <div className="gallery-grid" onClick={() => selectOnly(null)}>
        {captures.length === 0 ? (
          <p className="empty">{t("gallery.empty")}</p>
        ) : (
          captures.map((c) => (
            <figure
              key={c.name}
              className={selection.includes(c.name) ? "tile selected" : "tile"}
              onClick={(e) => {
                e.stopPropagation();
                clickTile(c.name, e);
              }}
              onDoubleClick={() => edit(c.name)}
              onMouseDown={(e) => {
                if (e.button === 0) press.current = { name: c.name, x: e.clientX, y: e.clientY };
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                if (!selection.includes(c.name)) selectOnly(c.name);
                setContext({ x: e.clientX, y: e.clientY, name: c.name });
              }}
            >
              <div className="tile-image">
                <img
                  src={`${convertFileSrc(c.name, "thumb")}?v=${c.modified_ms}`}
                  alt=""
                  loading="lazy"
                  draggable={false}
                />
                {c.video && (
                  <span className="play-badge">
                    <Play size={18} fill="currentColor" />
                  </span>
                )}
                {linkOf(c.name) && (
                  <span className="link-badge" title={linkOf(c.name)}>
                    <Link2 size={14} />
                  </span>
                )}
              </div>
              <figcaption>{c.name}</figcaption>
            </figure>
          ))
        )}
      </div>

      <footer className="action-bar">
        <BigButton
          icon={<Camera size={28} />}
          label={t("gallery.captureRegion")}
          ring="#e5484d"
          onClick={() => capture("region")}
          menu={[
            { label: t("gallery.captureRegion") + hotkeyHint(settings?.hotkeys.capture_region), onSelect: () => capture("region") },
            { label: t("gallery.captureScreen") + hotkeyHint(settings?.hotkeys.capture_screen), onSelect: () => capture("screen") },
            { label: t("gallery.captureAll") + hotkeyHint(settings?.hotkeys.capture_all), onSelect: () => capture("all") },
          ]}
        />
        <BigButton
          icon={<Video size={28} />}
          label={t("gallery.recordVideo")}
          ring="#e5484d"
          onClick={() => record("region")}
          menu={[
            { label: t("gallery.recordRegion") + hotkeyHint(settings?.hotkeys.record_region), onSelect: () => record("region") },
            { label: t("gallery.recordScreen") + hotkeyHint(settings?.hotkeys.record_screen), onSelect: () => record("screen") },
            {
              label: t("common.microphone"),
              checked: settings?.record_microphone ?? false,
              onSelect: () => updateSettings({ record_microphone: !settings?.record_microphone }),
            },
            {
              label: t("common.systemAudio"),
              checked: settings?.record_system_audio ?? false,
              onSelect: () => updateSettings({ record_system_audio: !settings?.record_system_audio }),
            },
          ]}
        />
        <BigButton
          icon={<PencilRuler size={26} />}
          label={t("gallery.editMenu")}
          ring="#30a46c"
          disabled={!selected}
          onClick={() => selected && edit(selected)}
          menu={selected ? itemActions(selected).slice(1) : undefined}
        />
        <div className="share-anchor">
          <BigButton
            icon={<CloudUpload size={28} />}
            label={t("gallery.publish")}
            ring="#2d8cff"
            disabled={uploading}
            onClick={() => {
              if (!sharePanel) refreshShares();
              setSharePanel(!sharePanel);
            }}
          />
          {sharePanel && (
            <SharePanel
              count={selection.length}
              hours={hours}
              shares={shares}
              onTemporary={() => share(selection, "litterbox")}
              onPermanent={() => share(selection, "catbox")}
              onEmail={() => email(selection)}
              onCopy={(url) => copyLinks([url])}
              onSettings={() => invoke("open_settings")}
              onClose={closeSharePanel}
            />
          )}
        </div>
        <div className="spacer" />
        <BigButton icon={<X size={28} />} label={t("common.close")} ring="#f76b15" onClick={() => win.hide()} />
      </footer>

      {askShare && (
        <div className="modal-backdrop" style={{ position: "fixed" }}>
          <div className="modal share-modal">
            <h3>{t("share.confirmTitle")}</h3>
            <p>
              {t("share.confirmText", { host: HOSTS[askShare.service] })}{" "}
              {askShare.service === "litterbox"
                ? t("share.confirmTemporary", { hours })
                : t("share.confirmPermanent")}
            </p>
            <label className="setting-check">
              <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
              <span>{t("share.dontAsk")}</span>
            </label>
            <div className="modal-buttons">
              <button onClick={confirmShare}>{t("share.upload")}</button>
              <button className="ghost" onClick={() => setAskShare(null)}>
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {context && (
        <Menu
          items={
            selection.length > 1 && selection.includes(context.name)
              ? multiActions(selection)
              : itemActions(context.name)
          }
          onClose={() => setContext(null)}
          style={{ position: "fixed", left: context.x, top: context.y }}
        />
      )}
    </div>
  );
}
