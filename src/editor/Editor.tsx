import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KonvaEventObject, Node as KonvaNode } from "konva/lib/Node";
import type Konva from "konva";
import { invoke } from "@tauri-apps/api/core";
import { t as tr } from "../i18n";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Braces,
  Circle as CircleIcon,
  MessageSquare,
  Pentagon,
  Copy,
  Crop as CropIcon,
  FileDown,
  Grid3x3,
  Highlighter,
  LogOut,
  Minus,
  MousePointer2,
  MoveUpRight,
  Pencil,
  Plus,
  Redo2,
  Save,
  Slash,
  Square,
  Trash2,
  Type,
  Undo2,
  X,
  ZoomIn,
} from "lucide-react";
import {
  Arrow,
  Circle,
  Ellipse,
  Group,
  Image as KImage,
  Layer,
  Line,
  Rect,
  Shape as KShape,
  Stage,
  Text,
  Transformer,
} from "react-konva";
import type { Context as KonvaContext } from "konva/lib/Context";
import type { Shape as KonvaShapeNode } from "konva/lib/Shape";
import { RibbonButton } from "../ui";
import {
  type Annotations,
  type BoxShape,
  type CalloutShape,
  COLORS,
  type Crop,
  type Doc,
  type History,
  type LineShape,
  MAGNIFY_ZOOM,
  type PenShape,
  type PolygonShape,
  SIZES,
  type Shape,
  TOOLS,
  type TextShape,
  type Tool,
  fontSize,
  historyOf,
  isBox,
  isCentred,
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
  /** Set when editing the text of a callout: its box, in image pixels. */
  box?: { w: number; h: number };
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
  pen: <Pencil size={20} />,
  polygon: <Pentagon size={20} />,
  callout: <MessageSquare size={20} />,
  brace: <Braces size={20} />,
  rect: <Square size={20} />,
  ellipse: <CircleIcon size={20} />,
  highlight: <Highlighter size={20} />,
  blur: <Grid3x3 size={20} />,
  magnify: <ZoomIn size={20} />,
  text: <Type size={20} />,
  step: <StepIcon />,
  crop: <CropIcon size={20} />,
};

/** Smallest crop kept, in image pixels; a stray click crops nothing. */
const MIN_CROP = 8;
/** Clicking this close (screen pixels) to the first vertex closes the polygon. */
const CLOSE_DISTANCE = 10;
const FONT_FAMILY = "system-ui, 'Segoe UI', sans-serif";

/** Path of a curly brace "}" filling w x h: tip on the middle of the right side. */
function bracePath(ctx: KonvaContext, w: number, h: number) {
  const r = Math.min(h / 4, w / 2);
  const mid = h / 2;
  const x = w / 2;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(x, 0, x, r);
  ctx.lineTo(x, mid - r);
  ctx.quadraticCurveTo(x, mid, w, mid);
  ctx.quadraticCurveTo(x, mid, x, mid + r);
  ctx.lineTo(x, h - r);
  ctx.quadraticCurveTo(x, h, 0, h);
}

/**
 * Path of a callout: a rounded box (w x h, at 0,0) plus a triangular tail towards (tx, ty),
 * in the same local coordinates. The tail leaves from the box side facing the tip.
 */
function calloutPath(ctx: KonvaContext, w: number, h: number, tx: number, ty: number, radius: number) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(w, 0, w, h, r);
  ctx.arcTo(w, h, 0, h, r);
  ctx.arcTo(0, h, 0, 0, r);
  ctx.arcTo(0, 0, w, 0, r);
  ctx.closePath();
  const inside = tx > 0 && tx < w && ty > 0 && ty < h;
  if (inside) return;
  // Base of the tail on the side the tip is past, its width a fraction of that side.
  const dx = tx < 0 ? -tx : tx > w ? tx - w : 0;
  const dy = ty < 0 ? -ty : ty > h ? ty - h : 0;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  if (dy >= dx) {
    const half = Math.max(4, Math.min(w / 6, 24));
    const cx = clamp(tx, r + half, w - r - half);
    const y = ty > h ? h : 0;
    ctx.moveTo(cx - half, y);
    ctx.lineTo(tx, ty);
    ctx.lineTo(cx + half, y);
  } else {
    const half = Math.max(4, Math.min(h / 6, 24));
    const cy = clamp(ty, r + half, h - r - half);
    const x = tx > w ? w : 0;
    ctx.moveTo(x, cy - half);
    ctx.lineTo(tx, ty);
    ctx.lineTo(x, cy + half);
  }
  ctx.closePath();
}

/** Lines of `text` wrapped to `maxWidth` with the context's current font. */
function wrapText(ctx: KonvaContext, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > maxWidth) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

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
  const [history, setHistory] = useState<History>(historyOf({ shapes: [] }));
  const [saved, setSaved] = useState<Doc | null>(null);
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
  /** Vertices of the polygon being drawn, the last pair following the mouse. */
  const [polyDraft, setPolyDraftState] = useState<number[] | null>(null);
  const polyRef = useRef<number[] | null>(null);
  const setPolyDraft = (p: number[] | null) => {
    polyRef.current = p;
    setPolyDraftState(p);
  };
  /** Area being dragged with the crop tool, in image pixels. */
  const [cropDraft, setCropDraftState] = useState<Crop | null>(null);
  const cropDraftRef = useRef<Crop | null>(null);
  const [resizeOpen, setResizeOpen] = useState(false);

  const viewRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const contentRef = useRef<Konva.Layer>(null);
  const uiRef = useRef<Konva.Layer>(null);
  const trRef = useRef<Konva.Transformer>(null);

  const doc = history.stack[history.index];
  const shapes = doc.shapes;
  const shown = preview ?? shapes;
  const dirty = saved !== null && doc !== saved;
  /** Visible part of the image and output scale, from the document. */
  const crop: Crop = doc.crop ?? { x: 0, y: 0, w: img?.width ?? 1, h: img?.height ?? 1 };
  const outScale = doc.scale ?? 1;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const setDraft = (s: Shape | null) => {
    draftRef.current = s;
    setDraftState(s);
  };
  const setCropDraft = (c: Crop | null) => {
    cropDraftRef.current = c;
    setCropDraftState(c);
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
      const parsed: Annotations | null = json ? JSON.parse(json) : null;
      const loaded: Doc = { shapes: parsed?.shapes ?? [], crop: parsed?.crop, scale: parsed?.scale };
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
      ? Math.min(1, (view.w - VIEW_PADDING) / crop.w, (view.h - VIEW_PADDING) / crop.h)
      : manualZoom;

  const commit = useCallback(
    (next: Shape[]) => setHistory((h) => push(h, { ...h.stack[h.index], shapes: next })),
    [],
  );
  /** Changes crop or output scale, as one undo step. */
  const commitDoc = (patch: Partial<Doc>) => setHistory((h) => push(h, { ...h.stack[h.index], ...patch }));
  const update = (id: string, f: (s: Shape) => Shape) => commit(shapes.map((s) => (s.id === id ? f(s) : s)));

  const pointer = () => {
    const p = stageRef.current!.getPointerPosition()!;
    return { x: p.x / zoom + crop.x, y: p.y / zoom + crop.y };
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
      case "polygon": {
        const p = polyRef.current;
        if (!p) {
          setPolyDraft([x, y, x, y]);
          break;
        }
        const fixed = p.slice(0, -2);
        const nearFirst = Math.hypot(x - fixed[0], y - fixed[1]) * zoom <= CLOSE_DISTANCE;
        if (nearFirst && fixed.length >= 6) finishPolygon(fixed);
        else setPolyDraft([...fixed, x, y, x, y]);
        break;
      }
      case "callout":
        setDraft({ ...base, kind: "callout", x, y, w: 0, h: 0, tx: x, ty: y, text: "" });
        break;
      case "crop":
        setCropDraft({ x, y, w: 0, h: 0 });
        break;
      case "pen":
        setDraft({ ...base, kind: "pen", points: [x, y] });
        break;
      case "arrow":
      case "line":
        setDraft({ ...base, kind: tool, points: [x, y, x, y] });
        break;
      case "rect":
      case "ellipse":
      case "highlight":
      case "blur":
      case "magnify":
      case "brace":
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
    const p = polyRef.current;
    if (p) {
      const { x, y } = pointer();
      setPolyDraft([...p.slice(0, -2), x, y]);
      return;
    }
    const c = cropDraftRef.current;
    if (c) {
      const { x, y } = pointer();
      setCropDraft({ ...c, w: x - c.x, h: y - c.y });
      return;
    }
    const d = draftRef.current;
    if (!d) return;
    const { x, y } = pointer();
    if (d.kind === "arrow" || d.kind === "line") setDraft({ ...d, points: [d.points[0], d.points[1], x, y] });
    else if (d.kind === "callout") setDraft({ ...d, w: x - d.x, h: y - d.y });
    else if (d.kind === "pen") {
      // Skip points closer than a screen pixel or two: smoother line, smaller document.
      const [lx, ly] = d.points.slice(-2);
      if (Math.hypot(x - lx, y - ly) >= 2 / zoom) setDraft({ ...d, points: [...d.points, x, y] });
    }
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
    const c = cropDraftRef.current;
    if (c && img) {
      setCropDraft(null);
      const n = normalizeBox(c);
      // Clamp to the image; the crop is made on the source, whatever was cropped before.
      const x = Math.max(0, Math.round(n.x));
      const y = Math.max(0, Math.round(n.y));
      const w = Math.min(img.width, Math.round(n.x + n.w)) - x;
      const h = Math.min(img.height, Math.round(n.y + n.h)) - y;
      if (w >= MIN_CROP && h >= MIN_CROP) {
        setHistory((hist) => push(hist, { ...hist.stack[hist.index], crop: { x, y, w, h } }));
        setFit(true);
        setTool("select");
      }
      return;
    }
    const d = draftRef.current;
    if (!d) return;
    setDraft(null);
    if (!isMeaningful(d)) return;
    if (d.kind === "callout") {
      const b = normalizeBox(d);
      // Tail below the box, towards the left third, as in a comic balloon.
      const callout: CalloutShape = { ...b, tx: b.x + b.w * 0.3, ty: b.y + b.h + Math.max(24, b.h * 0.35) };
      commit([...shapes, callout]);
      setSelectedId(d.id);
      setTextEdit({ id: d.id, x: b.x, y: b.y, color: d.color, width: d.width, value: "", box: { w: b.w, h: b.h } });
      return;
    }
    commit([...shapes, isBox(d) ? normalizeBox(d) : d]);
    setSelectedId(d.id);
  }, [commit, shapes, img]);

  /** Ends the polygon; vertices doubled by a double click are merged. */
  const finishPolygon = (vertices: number[]) => {
    setPolyDraft(null);
    const points: number[] = [];
    for (let i = 0; i < vertices.length; i += 2) {
      const [x, y] = [vertices[i], vertices[i + 1]];
      const n = points.length;
      if (n && Math.hypot(x - points[n - 2], y - points[n - 1]) * zoom < 3) continue;
      points.push(x, y);
    }
    if (points.length < 6) return;
    const shape: PolygonShape = { id: crypto.randomUUID(), kind: "polygon", color, width: strokeWidth, points };
    commit([...shapes, shape]);
    setSelectedId(shape.id);
  };

  // A polygon left unfinished is dropped when switching tool.
  useEffect(() => {
    if (tool !== "polygon") setPolyDraft(null);
  }, [tool]);

  useEffect(() => {
    window.addEventListener("mouseup", finishDraft);
    return () => window.removeEventListener("mouseup", finishDraft);
  }, [finishDraft]);

  // --- text ----------------------------------------------------------------------------

  const commitText = () => {
    if (!textEdit) return;
    const { id, value } = textEdit;
    setTextEdit(null);
    if (id && textEdit.box) {
      update(id, (s) => (s.kind === "callout" ? { ...s, text: value } : s));
    } else if (id) {
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
    const transformable = selected && (isBox(selected) || selected.kind === "text" || selected.kind === "callout");
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
    } else if (s.kind === "callout") {
      const [dx, dy] = [n.x() - s.x, n.y() - s.y];
      update(s.id, (sh) => ({ ...(sh as CalloutShape), x: n.x(), y: n.y(), tx: s.tx + dx, ty: s.ty + dy }));
    } else if (s.kind === "pen" || s.kind === "polygon") {
      const [dx, dy] = [n.x(), n.y()];
      n.position({ x: 0, y: 0 });
      update(s.id, (sh) => ({
        ...(sh as PenShape | PolygonShape),
        points: s.points.map((v, i) => v + (i % 2 === 0 ? dx : dy)),
      }));
    } else if (isCentred(s)) {
      update(s.id, (sh) => ({ ...sh, x: n.x() - s.w / 2, y: n.y() - s.h / 2 }));
    } else {
      update(s.id, (sh) => ({ ...sh, x: n.x(), y: n.y() }));
    }
  };

  const onTransformEnd = (s: BoxShape | TextShape | CalloutShape) => (e: KonvaEventObject<Event>) => {
    const n = e.target;
    const rotation = n.rotation();
    if (s.kind === "callout") {
      const [w, h] = [s.w * n.scaleX(), s.h * n.scaleY()];
      n.scale({ x: 1, y: 1 });
      update(s.id, (sh) => ({ ...sh, x: n.x(), y: n.y(), w, h }));
      return;
    }
    if (s.kind === "text") {
      n.scale({ x: 1, y: 1 });
      update(s.id, (sh) => ({ ...sh, x: n.x(), y: n.y(), rotation }));
      return;
    }
    const [w, h] = [s.w * n.scaleX(), s.h * n.scaleY()];
    n.scale({ x: 1, y: 1 });
    const [x, y] = isCentred(s) ? [n.x() - w / 2, n.y() - h / 2] : [n.x(), n.y()];
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
      case "pen":
        return (
          <Line
            key={s.id}
            {...handlers}
            points={s.points}
            stroke={s.color}
            strokeWidth={s.width}
            tension={0.4}
            lineCap="round"
            lineJoin="round"
            hitStrokeWidth={hit}
          />
        );
      case "magnify": {
        // The fill pattern is the image scaled by MAGNIFY_ZOOM, offset so the centre of the
        // ellipse shows the image point under that centre.
        const cx = s.x + s.w / 2;
        const cy = s.y + s.h / 2;
        return (
          <Ellipse
            key={s.id}
            {...handlers}
            onTransformEnd={onTransformEnd(s)}
            x={cx}
            y={cy}
            radiusX={Math.abs(s.w) / 2}
            radiusY={Math.abs(s.h) / 2}
            fillPatternImage={img ?? undefined}
            fillPatternScaleX={MAGNIFY_ZOOM}
            fillPatternScaleY={MAGNIFY_ZOOM}
            fillPatternOffsetX={cx}
            fillPatternOffsetY={cy}
            fillPatternRepeat="no-repeat"
            stroke={s.color}
            strokeWidth={s.width}
            shadowColor="#000000"
            shadowBlur={s.width * 2}
            shadowOpacity={0.35}
          />
        );
      }
      case "polygon":
        return (
          <Line
            key={s.id}
            {...handlers}
            points={s.points}
            closed
            stroke={s.color}
            strokeWidth={s.width}
            lineJoin="round"
            hitStrokeWidth={hit}
            fillEnabled={false}
          />
        );
      case "brace":
        return (
          <KShape
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
            lineCap="round"
            lineJoin="round"
            hitStrokeWidth={hit}
            fillEnabled={false}
            sceneFunc={(ctx: KonvaContext, shape: KonvaShapeNode) => {
              bracePath(ctx, s.w, s.h);
              ctx.fillStrokeShape(shape);
            }}
          />
        );
      case "callout": {
        const size = fontSize(s.width);
        const pad = size * 0.6;
        const editing = textEdit?.id === s.id;
        return (
          <KShape
            key={s.id}
            {...handlers}
            onTransformEnd={onTransformEnd(s)}
            onDblClick={() =>
              setTextEdit({
                id: s.id,
                x: s.x,
                y: s.y,
                color: s.color,
                width: s.width,
                value: s.text,
                box: { w: s.w, h: s.h },
              })
            }
            x={s.x}
            y={s.y}
            width={s.w}
            height={s.h}
            fill={s.color}
            shadowColor="#000000"
            shadowBlur={8}
            shadowOpacity={0.3}
            shadowOffsetY={2}
            sceneFunc={(ctx: KonvaContext, shape: KonvaShapeNode) => {
              calloutPath(ctx, s.w, s.h, s.tx - s.x, s.ty - s.y, size * 0.8);
              ctx.fillStrokeShape(shape);
              if (editing || !s.text) return;
              // Text after the balloon, without its shadow: centred, wrapped to the box.
              ctx.setAttr("shadowColor", "transparent");
              ctx.setAttr("fillStyle", badgeText(s.color));
              ctx.setAttr("font", `600 ${size}px ${FONT_FAMILY}`);
              ctx.setAttr("textAlign", "center");
              ctx.setAttr("textBaseline", "middle");
              const lines = wrapText(ctx, s.text, Math.max(1, s.w - pad * 2));
              const lineHeight = size * 1.25;
              const top = s.h / 2 - ((lines.length - 1) * lineHeight) / 2;
              lines.forEach((line, i) => ctx.fillText(line, s.w / 2, top + i * lineHeight));
            }}
            hitFunc={(ctx: KonvaContext, shape: KonvaShapeNode) => {
              calloutPath(ctx, s.w, s.h, s.tx - s.x, s.ty - s.y, size * 0.8);
              ctx.fillStrokeShape(shape);
            }}
          />
        );
      }
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

  /** Handle on the tip of the selected callout's tail; drag it to point elsewhere. */
  const tailHandle = () => {
    if (selected?.kind !== "callout") return null;
    const s = (shown.find((sh) => sh.id === selected.id) ?? selected) as CalloutShape;
    const size = HANDLE / zoom;
    const moved = (node: KonvaNode) =>
      shapes.map((sh) =>
        sh.id === s.id ? { ...selected, tx: node.x() + size / 2, ty: node.y() + size / 2 } : sh,
      );
    return (
      <Rect
        x={s.tx - size / 2}
        y={s.ty - size / 2}
        width={size}
        height={size}
        fill="#f76b15"
        stroke="#1c1f24"
        strokeWidth={1 / zoom}
        draggable
        onMouseEnter={() => setCursor("crosshair")}
        onMouseLeave={() => setCursor("")}
        onDragMove={(e) => setPreview(moved(e.target))}
        onDragEnd={(e) => {
          commit(moved(e.target));
          setPreview(null);
        }}
      />
    );
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

  /** Dims everything outside the area being cropped, with a dashed border around it. */
  const cropShade = (c: Crop) => {
    const full = { x: crop.x, y: crop.y, w: crop.w, h: crop.h };
    const shade = "rgba(0, 0, 0, 0.55)";
    return (
      <Group listening={false}>
        <Rect x={full.x} y={full.y} width={full.w} height={c.y - full.y} fill={shade} />
        <Rect x={full.x} y={c.y + c.h} width={full.w} height={full.y + full.h - c.y - c.h} fill={shade} />
        <Rect x={full.x} y={c.y} width={c.x - full.x} height={c.h} fill={shade} />
        <Rect x={c.x + c.w} y={c.y} width={full.x + full.w - c.x - c.w} height={c.h} fill={shade} />
        <Rect x={c.x} y={c.y} width={c.w} height={c.h} stroke="#ffffff" strokeWidth={1.5 / zoom} dash={[6 / zoom, 4 / zoom]} />
      </Group>
    );
  };

  // --- save / export -------------------------------------------------------------------

  /** Renders the content layer at 1:1 image pixels, without selection handles. */
  const exportPng = async (): Promise<Uint8Array> => {
    const stage = stageRef.current!;
    const content = contentRef.current!;
    const ui = uiRef.current!;
    const size = stage.size();
    const position = content.position();
    ui.visible(false);
    content.scale({ x: 1, y: 1 });
    content.position({ x: -crop.x, y: -crop.y });
    stage.size({ width: crop.w, height: crop.h });
    let canvas: HTMLCanvasElement;
    try {
      // pixelRatio resizes the output (smoothly) to the chosen scale.
      canvas = content.toCanvas({ x: 0, y: 0, width: crop.w, height: crop.h, pixelRatio: outScale });
    } finally {
      stage.size(size);
      content.position(position);
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
      const stored: Annotations = { version: 1, shapes, crop: doc.crop, scale: doc.scale };
      await invoke("save_annotations", { name, json: JSON.stringify(stored) });
      await invoke("save_edit_image", png, { headers: { "x-name": encodeURIComponent(name) } });
      setSaved(doc);
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

  /** Saves, then writes a copy as PNG, JPG or PDF where the user picks. */
  const saveAs = async () => {
    if (!(await save())) return;
    try {
      const path = await invoke<string | null>("export_capture", { name });
      if (path) notify(tr("editor.exported", { path }));
    } catch (e) {
      notify(String(e));
    }
  };

  // --- keyboard ------------------------------------------------------------------------

  const undo = () => setHistory((h) => ({ ...h, index: Math.max(0, h.index - 1) }));
  const redo = () => setHistory((h) => ({ ...h, index: Math.min(h.stack.length - 1, h.index + 1) }));

  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent) => {
    if (textEdit || askClose || resizeOpen || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement)
      return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === "z") (e.shiftKey ? redo : undo)();
    else if (mod && key === "y") redo();
    else if (mod && key === "s") save();
    else if (mod && key === "c") copyImage();
    else if (e.key === "Delete" || e.key === "Backspace") removeSelected();
    else if (polyRef.current && e.key === "Enter") finishPolygon(polyRef.current.slice(0, -2));
    else if (e.key === "Escape") {
      if (polyRef.current) setPolyDraft(null);
      else if (selectedId) setSelectedId(null);
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
          icon={<FileDown size={20} />}
          tint="#2d8cff"
          label={tr("editor.saveAs")}
          onClick={saveAs}
          disabled={busy}
          title={tr("editor.saveAsHint")}
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
              style={{ width: crop.w * zoom, height: crop.h * zoom }}
            >
              <Stage
                ref={stageRef}
                width={crop.w * zoom}
                height={crop.h * zoom}
                onMouseDown={onStageDown}
                onMouseMove={onStageMove}
                onDblClick={() => polyRef.current && finishPolygon(polyRef.current.slice(0, -2))}
              >
                <Layer ref={contentRef} scaleX={zoom} scaleY={zoom} x={-crop.x * zoom} y={-crop.y * zoom}>
                  <KImage image={img} name="background" />
                  {shown.map((s) => renderShape(s, true))}
                  {draft && renderShape(draft, false)}
                  {polyDraft && (
                    <Line
                      points={polyDraft}
                      stroke={color}
                      strokeWidth={strokeWidth}
                      lineJoin="round"
                      dash={[strokeWidth * 2, strokeWidth * 2]}
                      listening={false}
                    />
                  )}
                </Layer>
                <Layer ref={uiRef} scaleX={zoom} scaleY={zoom} x={-crop.x * zoom} y={-crop.y * zoom}>
                  {cropDraft && cropShade(normalizeBox(cropDraft))}
                  <Transformer
                    ref={trRef}
                    rotateEnabled={
                      selected?.kind !== "blur" && selected?.kind !== "magnify" && selected?.kind !== "callout"
                    }
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
                  {tailHandle()}
                </Layer>
              </Stage>
              {textEdit && (
                <textarea
                  className={textEdit.box ? "text-edit callout-edit" : "text-edit"}
                  autoFocus
                  value={textEdit.value}
                  style={{
                    left: (textEdit.x - crop.x) * zoom,
                    top: (textEdit.y - crop.y) * zoom,
                    color: textEdit.box ? badgeText(textEdit.color) : textEdit.color,
                    fontSize: fontSize(textEdit.width) * zoom,
                    ...(textEdit.box && {
                      width: textEdit.box.w * zoom,
                      height: textEdit.box.h * zoom,
                      padding: fontSize(textEdit.width) * 0.6 * zoom,
                    }),
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
        {img && (
          <button className="size-button" onClick={() => setResizeOpen(true)} title={tr("editor.resize")}>
            {Math.round(crop.w * outScale)} x {Math.round(crop.h * outScale)}
          </button>
        )}
        {doc.crop && (
          <button onClick={() => commitDoc({ crop: undefined })} title={tr("editor.resetCrop")}>
            <CropIcon size={14} /> {tr("editor.resetCrop")}
          </button>
        )}
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

      {resizeOpen && img && (
        <ResizeDialog
          width={crop.w}
          height={crop.h}
          scale={outScale}
          onApply={(s) => {
            setResizeOpen(false);
            if (s !== outScale) commitDoc({ scale: s === 1 ? undefined : s });
          }}
          onCancel={() => setResizeOpen(false)}
        />
      )}

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

/** Output size of the image: width, height and percentage stay proportional. */
function ResizeDialog({
  width,
  height,
  scale,
  onApply,
  onCancel,
}: {
  width: number;
  height: number;
  scale: number;
  onApply: (scale: number) => void;
  onCancel: () => void;
}) {
  const [s, setS] = useState(scale);
  const set = (value: number, base: number) => {
    if (Number.isFinite(value) && value > 0) setS(Math.min(8, Math.max(0.05, value / base)));
  };
  return (
    <div className="modal-backdrop">
      <form
        className="modal resize-modal"
        onSubmit={(e) => {
          e.preventDefault();
          onApply(s);
        }}
      >
        <h3>{tr("editor.resizeTitle")}</h3>
        <label>
          <span>{tr("editor.width")}</span>
          <input type="number" min={1} value={Math.round(width * s)} onChange={(e) => set(Number(e.target.value), width)} autoFocus />
        </label>
        <label>
          <span>{tr("editor.height")}</span>
          <input type="number" min={1} value={Math.round(height * s)} onChange={(e) => set(Number(e.target.value), height)} />
        </label>
        <label>
          <span>%</span>
          <input type="number" min={5} max={800} value={Math.round(s * 100)} onChange={(e) => set(Number(e.target.value), 100)} />
        </label>
        <div className="modal-buttons">
          <button type="submit">{tr("editor.apply")}</button>
          <button type="button" className="ghost" onClick={() => setS(1)}>
            {tr("editor.originalSize")}
          </button>
          <button type="button" className="ghost" onClick={onCancel}>
            {tr("common.cancel")}
          </button>
        </div>
      </form>
    </div>
  );
}
