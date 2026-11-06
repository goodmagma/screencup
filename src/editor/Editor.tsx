import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KonvaEventObject, Node as KonvaNode } from "konva/lib/Node";
import type Konva from "konva";
import { invoke } from "@tauri-apps/api/core";
import { t as tr } from "../i18n";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Circle as CircleIcon,
  Copy,
  Grid3x3,
  Highlighter,
  LogOut,
  Minus,
  MousePointer2,
  MoveUpRight,
  Plus,
  Redo2,
  Save,
  Slash,
  Square,
  Trash2,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { Arrow, Circle, Ellipse, Group, Image as KImage, Layer, Line, Rect, Stage, Text, Transformer } from "react-konva";
import { RibbonButton } from "../ui";
import {
  type Annotations,
  type BoxShape,
  COLORS,
  type History,
  type LineShape,
  SIZES,
  type Shape,
  TOOLS,
  type TextShape,
  type Tool,
  fontSize,
  historyOf,
  isBox,
  isMeaningful,
  normalizeBox,
  pixelate,
  push,
  sizeScale,
  stepRadius,
} from "./model";

/** Open text box, in image pixels. `id` is null while typing a new text. */
interface TextEdit {
  id: string | null;
  x: number;
  y: number;
  color: string;
  width: number;
  value: string;
}

const VIEW_PADDING = 32;
const ZOOM_STEP = 1.2;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 4;
const HANDLE = 8;
const ACCENT = "#2d8cff";

/** Text colour that stays readable on a step badge of the given fill. */
const badgeText = (fill: string) => (fill === "#ffffff" || fill === "#ffc53d" ? "#1c1f24" : "#ffffff");

function StepIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
      <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <text x="10" y="14.5" textAnchor="middle" fontSize="12" fontWeight="bold" fill="currentColor">
        1
      </text>
    </svg>
  );
}

const TOOL_ICONS: Record<Tool, ReactNode> = {
  select: <MousePointer2 size={20} />,
  arrow: <MoveUpRight size={20} />,
  line: <Slash size={20} />,
  rect: <Square size={20} />,
  ellipse: <CircleIcon size={20} />,
  highlight: <Highlighter size={20} />,
  blur: <Grid3x3 size={20} />,
  text: <Type size={20} />,
  step: <StepIcon />,
};

const win = getCurrentWindow();

/** Editor in its own window: closing asks about unsaved changes. */
export function EditorWindow({ name, notify }: { name: string; notify: (message: string) => void }) {
  return <Editor name={name} notify={notify} onClose={() => win.destroy()} />;
}

interface Props {
  name: string;
  onClose: () => void;
  notify: (message: string) => void;
}

export function Editor({ name, onClose, notify }: Props) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [history, setHistory] = useState<History>(historyOf([]));
  const [saved, setSaved] = useState<Shape[]>([]);
  /** Shapes shown while an endpoint handle is dragged, before the change is committed. */
  const [preview, setPreview] = useState<Shape[] | null>(null);
  const [draft, setDraftState] = useState<Shape | null>(null);
  const draftRef = useRef<Shape | null>(null);
  const [tool, setTool] = useState<Tool>("arrow");
  const [color, setColor] = useState(COLORS[0]);
  const [sizeIdx, setSizeIdx] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);
  const [fit, setFit] = useState(true);
  const [manualZoom, setManualZoom] = useState(1);
  const [view, setView] = useState({ w: 800, h: 600 });
  const [busy, setBusy] = useState(false);
  const [askClose, setAskClose] = useState(false);

  const viewRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const contentRef = useRef<Konva.Layer>(null);
  const uiRef = useRef<Konva.Layer>(null);
  const trRef = useRef<Konva.Transformer>(null);

  const shapes = history.stack[history.index];
  const shown = preview ?? shapes;
  const dirty = shapes !== saved;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const setDraft = (s: Shape | null) => {
    draftRef.current = s;
    setDraftState(s);
  };

  // Load the source pixels (the original when edited before) and saved annotations.
  useEffect(() => {
    let url: string | undefined;
    let cancelled = false;
    (async () => {
      const [bytes, json] = await Promise.all([
        invoke<ArrayBuffer | number[]>("read_edit_source", { name }),
        invoke<string | null>("load_annotations", { name }),
      ]);
      // A raw response arrives as an ArrayBuffer over the ipc: protocol but as a plain number
      // array when Tauri falls back to postMessage IPC.
      const data = Array.isArray(bytes) ? new Uint8Array(bytes) : bytes;
      url = URL.createObjectURL(new Blob([data], { type: "image/png" }));
      const image = new window.Image();
      image.src = url;
      await image.decode();
      if (cancelled) return;
      const loaded = json ? (JSON.parse(json) as Annotations).shapes : [];
      setImg(image);
      setHistory(historyOf(loaded));
      setSaved(loaded);
    })().catch((e) => notify(String(e)));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [name, notify]);

  // The window close button asks first when there are unsaved changes.
  useEffect(() => {
    const off = win.onCloseRequested((e) => {
      if (dirtyRef.current) {
        e.preventDefault();
        setAskClose(true);
      }
    });
    return () => {
      off.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setView({ w: entry.contentRect.width, h: entry.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pixelated = useMemo(() => (img ? pixelate(img) : null), [img]);
  const scale = img ? sizeScale(img.width, img.height) : 1;
  const strokeWidth = SIZES[sizeIdx] * scale;
  const zoom = !img
    ? 1
    : fit
      ? Math.min(1, (view.w - VIEW_PADDING) / img.width, (view.h - VIEW_PADDING) / img.height)
      : manualZoom;

  const commit = useCallback((next: Shape[]) => setHistory((h) => push(h, next)), []);
  const update = (id: string, f: (s: Shape) => Shape) => commit(shapes.map((s) => (s.id === id ? f(s) : s)));

  const pointer = () => {
    const p = stageRef.current!.getPointerPosition()!;
    return { x: p.x / zoom, y: p.y / zoom };
  };

  const setCursor = (cursor: string) => {
    const el = stageRef.current?.container();
    if (el) el.style.cursor = cursor;
  };

  // --- drawing -------------------------------------------------------------------------

  const onStageDown = (e: KonvaEventObject<MouseEvent>) => {
    if (e.evt.button !== 0 || textEdit) return;
    // Pressing on a shape or a handle selects / drags it, whatever the tool.
    const onEmpty = e.target === e.target.getStage() || e.target.name() === "background";
    if (!onEmpty) return;
    setSelectedId(null);
    setCursor("");
    if (tool === "select") return;
    // The text box is focused while this handler runs; without this the browser's default
    // mousedown action moves focus back to the page, blurring (and dropping) the empty box.
    e.evt.preventDefault();
    const { x, y } = pointer();
    const base = { id: crypto.randomUUID(), color, width: strokeWidth };
    switch (tool) {
      case "arrow":
      case "line":
        setDraft({ ...base, kind: tool, points: [x, y, x, y] });
        break;
      case "rect":
      case "ellipse":
      case "highlight":
      case "blur":
        setDraft({ ...base, kind: tool, x, y, w: 0, h: 0 });
        break;
      case "text":
        setTextEdit({ id: null, x, y, color, width: strokeWidth, value: "" });
        break;
      case "step": {
        const n = Math.max(0, ...shapes.map((s) => (s.kind === "step" ? s.n : 0))) + 1;
        commit([...shapes, { ...base, kind: "step", x, y, n }]);
        setSelectedId(base.id);
        break;
      }
    }
  };

  const onStageMove = (e: KonvaEventObject<MouseEvent>) => {
    const d = draftRef.current;
    if (!d) return;
    const { x, y } = pointer();
    if (d.kind === "arrow" || d.kind === "line") setDraft({ ...d, points: [d.points[0], d.points[1], x, y] });
    else if (isBox(d)) {
      let w = x - d.x;
      let h = y - d.y;
      // Alt keeps width and height equal (square, circle), like graphics editors do.
      if (e.evt.altKey) {
        const side = Math.max(Math.abs(w), Math.abs(h));
        w = (w < 0 ? -1 : 1) * side;
        h = (h < 0 ? -1 : 1) * side;
      }
      setDraft({ ...d, w, h });
    }
  };

  // Released anywhere, even outside the canvas. The new shape is selected right away.
  const finishDraft = useCallback(() => {
    const d = draftRef.current;
    if (!d) return;
    setDraft(null);
    if (!isMeaningful(d)) return;
    commit([...shapes, isBox(d) ? normalizeBox(d) : d]);
    setSelectedId(d.id);
  }, [commit, shapes]);

  useEffect(() => {
    window.addEventListener("mouseup", finishDraft);
    return () => window.removeEventListener("mouseup", finishDraft);
  }, [finishDraft]);

  // --- text ----------------------------------------------------------------------------

  const commitText = () => {
    if (!textEdit) return;
    const { id, value } = textEdit;
    setTextEdit(null);
    if (id) {
      if (value.trim()) update(id, (s) => (s.kind === "text" ? { ...s, text: value } : s));
      else commit(shapes.filter((s) => s.id !== id));
    } else if (value.trim()) {
      const { x, y, color, width } = textEdit;
      const newId = crypto.randomUUID();
      commit([...shapes, { id: newId, kind: "text", x, y, color, width, text: value }]);
      setSelectedId(newId);
    }
  };

  // --- selection -----------------------------------------------------------------------

  const selected = shapes.find((s) => s.id === selectedId);

  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    const transformable = selected && (isBox(selected) || selected.kind === "text");
    const node = transformable ? stageRef.current?.findOne((n: KonvaNode) => n.id() === selected.id) : undefined;
    tr.nodes(node ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [selected, shapes]);

  const onDragEnd = (s: Shape) => (e: KonvaEventObject<DragEvent>) => {
    const n = e.target;
    if (s.kind === "arrow" || s.kind === "line") {
      const [dx, dy] = [n.x(), n.y()];
      n.position({ x: 0, y: 0 });
      const [x1, y1, x2, y2] = s.points;
      update(s.id, (sh) => ({ ...(sh as LineShape), points: [x1 + dx, y1 + dy, x2 + dx, y2 + dy] }));
    } else if (s.kind === "ellipse") {
      update(s.id, (sh) => ({ ...sh, x: n.x() - s.w / 2, y: n.y() - s.h / 2 }));
    } else {
      update(s.id, (sh) => ({ ...sh, x: n.x(), y: n.y() }));
    }
  };

  const onTransformEnd = (s: BoxShape | TextShape) => (e: KonvaEventObject<Event>) => {
    const n = e.target;
    const rotation = n.rotation();
    if (s.kind === "text") {
      n.scale({ x: 1, y: 1 });
      update(s.id, (sh) => ({ ...sh, x: n.x(), y: n.y(), rotation }));
      return;
    }
    const [w, h] = [s.w * n.scaleX(), s.h * n.scaleY()];
    n.scale({ x: 1, y: 1 });
    const [x, y] = s.kind === "ellipse" ? [n.x() - w / 2, n.y() - h / 2] : [n.x(), n.y()];
    update(s.id, (sh) => ({ ...sh, x, y, w, h, rotation }));
  };

  const moveEndpoint = (s: LineShape, end: 0 | 1, node: KonvaNode) => {
    const points = [...s.points] as LineShape["points"];
    points[end * 2] = node.x() + HANDLE / zoom / 2;
    points[end * 2 + 1] = node.y() + HANDLE / zoom / 2;
    return shapes.map((sh) => (sh.id === s.id ? { ...s, points } : sh));
  };

  const removeSelected = () => {
    if (!selectedId) return;
    commit(shapes.filter((s) => s.id !== selectedId));
    setSelectedId(null);
    setCursor("");
  };

  // A shape removed or a tool switched while hovering never fires mouseleave.
  useEffect(() => setCursor(""), [tool]);

  // --- render ----------------------------------------------------------------------------

  const renderShape = (s: Shape, interactive: boolean) => {
    const handlers = {
      id: s.id,
      listening: interactive,
      draggable: interactive,
      onMouseDown: () => setSelectedId(s.id),
      onDragStart: () => setSelectedId(s.id),
      onDragEnd: onDragEnd(s),
      onMouseEnter: () => setCursor("move"),
      onMouseLeave: () => setCursor(""),
    };
    const hit = Math.max(s.width, 12 / zoom);
    switch (s.kind) {
      case "arrow":
        return (
          <Arrow
            key={s.id}
            {...handlers}
            points={s.points}
            stroke={s.color}
            fill={s.color}
            strokeWidth={s.width}
            pointerLength={s.width * 3 + 6}
            pointerWidth={s.width * 3 + 6}
            lineCap="round"
            lineJoin="round"
            hitStrokeWidth={hit}
          />
        );
      case "line":
        return (
          <Line
            key={s.id}
            {...handlers}
            points={s.points}
            stroke={s.color}
            strokeWidth={s.width}
            lineCap="round"
            hitStrokeWidth={hit}
          />
        );
      case "rect":
        return (
          <Rect
            key={s.id}
            {...handlers}
            onTransformEnd={onTransformEnd(s)}
            x={s.x}
            y={s.y}
            width={s.w}
            height={s.h}
            rotation={s.rotation ?? 0}
            stroke={s.color}
            strokeWidth={s.width}
            cornerRadius={s.width}
            hitStrokeWidth={hit}
            // Unfilled: only the outline is hit, so tools work inside the shape.
            fillEnabled={false}
          />
        );
      case "ellipse":
        return (
          <Ellipse
            key={s.id}
            {...handlers}
            onTransformEnd={onTransformEnd(s)}
            x={s.x + s.w / 2}
            y={s.y + s.h / 2}
            radiusX={Math.abs(s.w) / 2}
            radiusY={Math.abs(s.h) / 2}
            rotation={s.rotation ?? 0}
            stroke={s.color}
            strokeWidth={s.width}
            hitStrokeWidth={hit}
            fillEnabled={false}
          />
        );
      case "highlight":
        return (
          <Rect
            key={s.id}
            {...handlers}
            onTransformEnd={onTransformEnd(s)}
            x={s.x}
            y={s.y}
            width={s.w}
            height={s.h}
            rotation={s.rotation ?? 0}
            fill={s.color}
            opacity={0.45}
            globalCompositeOperation="multiply"
          />
        );
      case "blur":
        return (
          <Rect
            key={s.id}
            {...handlers}
            onTransformEnd={onTransformEnd(s)}
            x={s.x}
            y={s.y}
            width={s.w}
            height={s.h}
            fillPatternImage={pixelated as unknown as HTMLImageElement}
            fillPatternOffsetX={s.x}
            fillPatternOffsetY={s.y}
            fillPatternRepeat="no-repeat"
          />
        );
      case "text":
        if (textEdit?.id === s.id) return null;
        return (
          <Text
            key={s.id}
            {...handlers}
            onTransformEnd={onTransformEnd(s)}
            onDblClick={() =>
              setTextEdit({ id: s.id, x: s.x, y: s.y, color: s.color, width: s.width, value: s.text })
            }
            x={s.x}
            y={s.y}
            rotation={s.rotation ?? 0}
            text={s.text}
            fill={s.color}
            fontSize={fontSize(s.width)}
            fontFamily="system-ui, 'Segoe UI', sans-serif"
            fontStyle="bold"
            lineHeight={1.2}
          />
        );
      case "step": {
        const r = stepRadius(s.width);
        return (
          <Group key={s.id} {...handlers} x={s.x} y={s.y}>
            <Circle radius={r} fill={s.color} stroke="#ffffff" strokeWidth={Math.max(1.5, s.width / 3)} />
            <Text
              text={String(s.n)}
              width={r * 2}
              height={r * 2}
              offsetX={r}
              offsetY={r}
              align="center"
              verticalAlign="middle"
              fontSize={r * 1.1}
              fontStyle="bold"
              fontFamily="system-ui, 'Segoe UI', sans-serif"
              fill={badgeText(s.color)}
            />
          </Group>
        );
      }
    }
  };

  /** Square handles on both ends of the selected arrow or line; drag one to move that end. */
  const endpointHandles = () => {
    if (!selected || (selected.kind !== "arrow" && selected.kind !== "line")) return null;
    const s = (shown.find((sh) => sh.id === selected.id) ?? selected) as LineShape;
    const size = HANDLE / zoom;
    return ([0, 1] as const).map((end) => (
      <Rect
        key={end}
        x={s.points[end * 2] - size / 2}
        y={s.points[end * 2 + 1] - size / 2}
        width={size}
        height={size}
        fill={end === 1 ? "#f76b15" : "#ffffff"}
        stroke="#1c1f24"
        strokeWidth={1 / zoom}
        draggable
        onMouseEnter={() => setCursor("crosshair")}
        onMouseLeave={() => setCursor("")}
        onDragMove={(e) => setPreview(moveEndpoint(selected, end, e.target))}
        onDragEnd={(e) => {
          commit(moveEndpoint(selected, end, e.target));
          setPreview(null);
        }}
      />
    ));
  };

  // --- save / export -------------------------------------------------------------------

  /** Renders the content layer at 1:1 image pixels, without selection handles. */
  const exportPng = async (): Promise<Uint8Array> => {
    const stage = stageRef.current!;
    const content = contentRef.current!;
    const ui = uiRef.current!;
    const size = stage.size();
    ui.visible(false);
    content.scale({ x: 1, y: 1 });
    stage.size({ width: img!.width, height: img!.height });
    let canvas: HTMLCanvasElement;
    try {
      canvas = content.toCanvas({ x: 0, y: 0, width: img!.width, height: img!.height, pixelRatio: 1 });
    } finally {
      stage.size(size);
      content.scale({ x: zoom, y: zoom });
      ui.visible(true);
      stage.batchDraw();
    }
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error(tr("editor.pngFailed"));
    return new Uint8Array(await blob.arrayBuffer());
  };

  const save = async () => {
    if (!img || busy) return false;
    if (!dirty) return true;
    setBusy(true);
    try {
      const png = await exportPng();
      const doc: Annotations = { version: 1, shapes };
      await invoke("save_annotations", { name, json: JSON.stringify(doc) });
      await invoke("save_edit_image", png, { headers: { "x-name": encodeURIComponent(name) } });
      setSaved(shapes);
      return true;
    } catch (e) {
      notify(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const copyImage = async () => {
    if (!(await save())) return false;
    try {
      await invoke("copy_capture", { name });
      notify(tr("common.copied"));
      return true;
    } catch (e) {
      notify(String(e));
      return false;
    }
  };

  const saveAndClose = async () => {
    if (await save()) onClose();
  };

  const copyAndClose = async () => {
    if (await copyImage()) onClose();
  };

  const requestClose = () => (dirty ? setAskClose(true) : onClose());

  // --- keyboard ------------------------------------------------------------------------

  const undo = () => setHistory((h) => ({ ...h, index: Math.max(0, h.index - 1) }));
  const redo = () => setHistory((h) => ({ ...h, index: Math.min(h.stack.length - 1, h.index + 1) }));

  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent) => {
    if (textEdit || askClose || e.target instanceof HTMLTextAreaElement) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === "z") (e.shiftKey ? redo : undo)();
    else if (mod && key === "y") redo();
    else if (mod && key === "s") save();
    else if (mod && key === "c") copyImage();
    else if (e.key === "Delete" || e.key === "Backspace") removeSelected();
    else if (e.key === "Escape") {
      if (selectedId) setSelectedId(null);
      else setTool("select");
    } else if (!mod && !e.altKey) {
      const t = TOOLS.find((t) => t.key === key);
      if (t) setTool(t.tool);
      else return;
    } else return;
    e.preventDefault();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const zoomTo = (z: number) => {
    setFit(false);
    setManualZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)));
  };

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey) zoomTo(zoom * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
  };

  // A colour or size picked with a shape selected restyles that shape.
  const pickColor = (c: string) => {
    setColor(c);
    if (selected && selected.kind !== "blur") update(selected.id, (s) => ({ ...s, color: c }));
  };
  const pickSize = (i: number) => {
    setSizeIdx(i);
    if (selected) update(selected.id, (s) => ({ ...s, width: SIZES[i] * scale }));
  };

  return (
    <div className="editor">
      <header className="ribbon">
        <RibbonButton
          icon={<LogOut size={20} />}
          tint="#30a46c"
          label={tr("editor.copyAndExit")}
          onClick={copyAndClose}
          disabled={busy}
          title={tr("editor.copyAndExitHint")}
        />
        <RibbonButton
          icon={<Save size={20} />}
          tint="#2d8cff"
          label={tr("editor.save")}
          onClick={saveAndClose}
          disabled={busy}
          title={tr("editor.saveHint")}
        />
        <RibbonButton
          icon={<Copy size={20} />}
          tint="#30a46c"
          label={tr("editor.copyImage")}
          onClick={copyImage}
          disabled={busy}
          title="Ctrl+C"
        />
        <div className="ribbon-sep" />
        <RibbonButton
          icon={<Undo2 size={20} />}
          tint="#f76b15"
          label={tr("editor.undo")}
          onClick={undo}
          disabled={history.index === 0}
          title="Ctrl+Z"
        />
        <RibbonButton
          icon={<Redo2 size={20} />}
          tint="#f76b15"
          label={tr("editor.redo")}
          onClick={redo}
          disabled={history.index === history.stack.length - 1}
          title="Ctrl+Y"
        />
        <RibbonButton
          icon={<Trash2 size={20} />}
          tint="#e5484d"
          label={tr("common.delete")}
          onClick={removeSelected}
          disabled={!selected}
          title={tr("editor.deleteHint")}
        />
        <div className="ribbon-sep" />
        <div className="ribbon-group">
          <div className="swatches">
            {COLORS.map((c) => (
              <button
                key={c}
                className={c === (selected?.color ?? color) ? "swatch active" : "swatch"}
                style={{ background: c }}
                onClick={() => pickColor(c)}
                title={c}
              />
            ))}
          </div>
          <span>{tr("editor.color")}</span>
        </div>
        <div className="ribbon-group">
          <div className="sizes">
            {SIZES.map((size, i) => (
              <button
                key={i}
                className={i === sizeIdx ? "size active" : "size"}
                onClick={() => pickSize(i)}
                title={tr((["editor.size0", "editor.size1", "editor.size2", "editor.size3"] as const)[i])}
              >
                <span style={{ height: Math.min(12, size + 1) }} />
              </button>
            ))}
          </div>
          <span>{tr("editor.size")}</span>
        </div>
        <div className="spacer" />
        <RibbonButton icon={<X size={20} />} tint="#f76b15" label={tr("common.close")} onClick={requestClose} />
      </header>

      <div className="editor-body">
        <nav className="toolcol">
          {TOOLS.map((t) => (
            <button
              key={t.tool}
              className={t.tool === tool ? "tool-button active" : "tool-button"}
              onClick={() => setTool(t.tool)}
              title={`${tr(`tool.${t.tool}`)} (${t.key.toUpperCase()})`}
            >
              {TOOL_ICONS[t.tool]}
            </button>
          ))}
        </nav>

        <div className="canvas-area" ref={viewRef} onWheel={onWheel}>
          {img && (
            <div
              className={`stage ${tool === "select" ? "" : tool === "text" ? "typing" : "drawing"}`}
              style={{ width: img.width * zoom, height: img.height * zoom }}
            >
              <Stage
                ref={stageRef}
                width={img.width * zoom}
                height={img.height * zoom}
                onMouseDown={onStageDown}
                onMouseMove={onStageMove}
              >
                <Layer ref={contentRef} scaleX={zoom} scaleY={zoom}>
                  <KImage image={img} name="background" />
                  {shown.map((s) => renderShape(s, true))}
                  {draft && renderShape(draft, false)}
                </Layer>
                <Layer ref={uiRef} scaleX={zoom} scaleY={zoom}>
                  <Transformer
                    ref={trRef}
                    rotateEnabled={selected?.kind !== "blur"}
                    enabledAnchors={
                      selected?.kind === "text"
                        ? []
                        : [
                            "top-left",
                            "top-center",
                            "top-right",
                            "middle-right",
                            "bottom-right",
                            "bottom-center",
                            "bottom-left",
                            "middle-left",
                          ]
                    }
                    keepRatio={false}
                    ignoreStroke
                    flipEnabled={false}
                    anchorSize={HANDLE}
                    anchorCornerRadius={0}
                    anchorStroke="#1c1f24"
                    anchorFill="#ffffff"
                    borderStroke={ACCENT}
                    borderDash={[4, 4]}
                    rotateAnchorOffset={24}
                    rotationSnaps={[0, 45, 90, 135, 180, 225, 270, 315]}
                  />
                  {endpointHandles()}
                </Layer>
              </Stage>
              {textEdit && (
                <textarea
                  className="text-edit"
                  autoFocus
                  value={textEdit.value}
                  style={{
                    left: textEdit.x * zoom,
                    top: textEdit.y * zoom,
                    color: textEdit.color,
                    fontSize: fontSize(textEdit.width) * zoom,
                  }}
                  onChange={(e) => setTextEdit({ ...textEdit, value: e.target.value })}
                  onBlur={commitText}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      commitText();
                    } else if (e.key === "Escape") {
                      setTextEdit(null);
                    }
                  }}
                />
              )}
            </div>
          )}
        </div>
      </div>

      <footer className="statusbar">
        <span>{img ? `${img.width} x ${img.height}` : ""}</span>
        <div className="spacer" />
        <span className="zoom-value">{Math.round(zoom * 100)}%</span>
        <button onClick={() => zoomTo(zoom / ZOOM_STEP)} title={tr("editor.zoomOut")}>
          <Minus size={14} />
        </button>
        <input
          type="range"
          min={ZOOM_MIN * 100}
          max={ZOOM_MAX * 100}
          value={Math.round(zoom * 100)}
          onChange={(e) => zoomTo(Number(e.target.value) / 100)}
        />
        <button onClick={() => zoomTo(zoom * ZOOM_STEP)} title={tr("editor.zoomIn")}>
          <Plus size={14} />
        </button>
        <button className={fit ? "fit active" : "fit"} onClick={() => setFit(true)}>
          {tr("editor.fit")}
        </button>
      </footer>

      {askClose && (
        <div className="modal-backdrop">
          <div className="modal">
            <p>{tr("editor.unsaved")}</p>
            <div className="modal-buttons">
              <button onClick={saveAndClose} disabled={busy}>
                {tr("editor.saveAndExit")}
              </button>
              <button className="danger" onClick={onClose}>
                {tr("editor.exitWithoutSaving")}
              </button>
              <button className="ghost" onClick={() => setAskClose(false)}>
                {tr("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
