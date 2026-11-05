import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KonvaEventObject, Node as KonvaNode } from "konva/lib/Node";
import type Konva from "konva";
import { invoke } from "@tauri-apps/api/core";
import { Arrow, Circle, Ellipse, Group, Image as KImage, Layer, Line, Rect, Stage, Text, Transformer } from "react-konva";
import {
  type Annotations,
  type BoxShape,
  COLORS,
  type History,
  type LineShape,
  SIZES,
  type Shape,
  TOOLS,
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

interface Props {
  name: string;
  onClose: () => void;
  notify: (message: string) => void;
}

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

/** Text colour that stays readable on a step badge of the given fill. */
const badgeText = (fill: string) => (fill === "#ffffff" || fill === "#ffc53d" ? "#1c1f24" : "#ffffff");

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
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const viewRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const contentRef = useRef<Konva.Layer>(null);
  const uiRef = useRef<Konva.Layer>(null);
  const trRef = useRef<Konva.Transformer>(null);

  const shapes = history.stack[history.index];
  const shown = preview ?? shapes;
  const dirty = shapes !== saved;

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
        invoke<ArrayBuffer>("read_edit_source", { name }),
        invoke<string | null>("load_annotations", { name }),
      ]);
      url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
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

  // --- drawing -------------------------------------------------------------------------

  const onStageDown = (e: KonvaEventObject<MouseEvent>) => {
    if (e.evt.button !== 0 || textEdit) return;
    if (tool === "select") {
      if (e.target === e.target.getStage() || e.target.name() === "background") setSelectedId(null);
      return;
    }
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
        break;
      }
    }
  };

  const onStageMove = () => {
    const d = draftRef.current;
    if (!d) return;
    const { x, y } = pointer();
    if (d.kind === "arrow" || d.kind === "line") setDraft({ ...d, points: [d.points[0], d.points[1], x, y] });
    else if (isBox(d)) setDraft({ ...d, w: x - d.x, h: y - d.y });
  };

  // Released anywhere, even outside the canvas.
  const finishDraft = useCallback(() => {
    const d = draftRef.current;
    if (!d) return;
    setDraft(null);
    if (isMeaningful(d)) commit([...shapes, isBox(d) ? normalizeBox(d) : d]);
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
      commit([...shapes, { id: crypto.randomUUID(), kind: "text", x, y, color, width, text: value }]);
    }
  };

  // --- selection -----------------------------------------------------------------------

  const selected = shapes.find((s) => s.id === selectedId);

  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    const node =
      tool === "select" && selected && isBox(selected)
        ? stageRef.current?.findOne((n: KonvaNode) => n.id() === selected.id)
        : undefined;
    tr.nodes(node ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [selected, tool, shapes]);

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

  const onTransformEnd = (s: BoxShape) => (e: KonvaEventObject<Event>) => {
    const n = e.target;
    const [w, h] = [s.w * n.scaleX(), s.h * n.scaleY()];
    n.scale({ x: 1, y: 1 });
    const [x, y] = s.kind === "ellipse" ? [n.x() - w / 2, n.y() - h / 2] : [n.x(), n.y()];
    update(s.id, (sh) => ({ ...sh, x, y, w, h }));
  };

  const moveEndpoint = (s: LineShape, end: 0 | 1, node: KonvaNode) => {
    const points = [...s.points] as LineShape["points"];
    points[end * 2] = node.x();
    points[end * 2 + 1] = node.y();
    return shapes.map((sh) => (sh.id === s.id ? { ...s, points } : sh));
  };

  // --- render ----------------------------------------------------------------------------

  const renderShape = (s: Shape, interactive: boolean) => {
    const handlers = {
      id: s.id,
      listening: interactive && tool === "select",
      draggable: interactive && tool === "select",
      onMouseDown: () => setSelectedId(s.id),
      onDragStart: () => setSelectedId(s.id),
      onDragEnd: onDragEnd(s),
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
            stroke={s.color}
            strokeWidth={s.width}
            cornerRadius={s.width}
            hitStrokeWidth={hit}
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
            stroke={s.color}
            strokeWidth={s.width}
            hitStrokeWidth={hit}
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
            onDblClick={() =>
              setTextEdit({ id: s.id, x: s.x, y: s.y, color: s.color, width: s.width, value: s.text })
            }
            x={s.x}
            y={s.y}
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
    if (!blob) throw new Error("PNG encoding failed");
    return new Uint8Array(await blob.arrayBuffer());
  };

  const save = async () => {
    if (!img || busy) return false;
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

  const saveAndClose = async () => {
    if (!dirty || (await save())) onClose();
  };

  const saveAndCopy = async () => {
    if (dirty && !(await save())) return;
    invoke("copy_capture", { name })
      .then(() => notify("Copied to clipboard"))
      .catch((e) => notify(String(e)));
  };

  const back = () => {
    if (dirty && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };

  // --- keyboard ------------------------------------------------------------------------

  const undo = () => setHistory((h) => ({ ...h, index: Math.max(0, h.index - 1) }));
  const redo = () => setHistory((h) => ({ ...h, index: Math.min(h.stack.length - 1, h.index + 1) }));

  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent) => {
    if (textEdit || e.target instanceof HTMLTextAreaElement) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === "z") (e.shiftKey ? redo : undo)();
    else if (mod && key === "y") redo();
    else if (mod && key === "s") saveAndClose();
    else if (mod && key === "c") saveAndCopy();
    else if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
      commit(shapes.filter((s) => s.id !== selectedId));
      setSelectedId(null);
    } else if (e.key === "Escape") {
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

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey) return;
    setFit(false);
    setManualZoom(Math.min(8, Math.max(0.1, zoom * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP))));
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
      <header className="toolbar editor-bar">
        <button className={confirmDiscard ? "danger" : "ghost"} onClick={back}>
          {confirmDiscard ? "Discard changes?" : "← Back"}
        </button>
        <div className="group">
          {TOOLS.map((t) => (
            <button
              key={t.tool}
              className={t.tool === tool ? "tool active" : "tool"}
              onClick={() => setTool(t.tool)}
              title={`${t.label} (${t.key.toUpperCase()})`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="group">
          {COLORS.map((c) => (
            <button
              key={c}
              className={c === color ? "swatch active" : "swatch"}
              style={{ background: c }}
              onClick={() => pickColor(c)}
              title={c}
            />
          ))}
        </div>
        <div className="group">
          {SIZES.map((_, i) => (
            <button key={i} className={i === sizeIdx ? "tool active" : "tool"} onClick={() => pickSize(i)}>
              {["S", "M", "L", "XL"][i]}
            </button>
          ))}
        </div>
        <div className="group">
          <button className="tool" onClick={undo} disabled={history.index === 0} title="Undo (Ctrl+Z)">
            Undo
          </button>
          <button
            className="tool"
            onClick={redo}
            disabled={history.index === history.stack.length - 1}
            title="Redo (Ctrl+Y)"
          >
            Redo
          </button>
        </div>
        <div className="group">
          <button className="tool" onClick={() => setFit(!fit)} title="Ctrl+wheel to zoom">
            {fit ? "Fit" : `${Math.round(zoom * 100)}%`}
          </button>
        </div>
        <div className="spacer" />
        <button className="ghost" onClick={saveAndCopy} disabled={busy} title="Ctrl+C">
          Copy
        </button>
        <button onClick={saveAndClose} disabled={busy} title="Ctrl+S">
          {dirty ? "Save" : "Done"}
        </button>
      </header>
      <div className="canvas-area" ref={viewRef} onWheel={onWheel}>
        {img && (
          <div
            className={tool === "select" ? "stage" : "stage drawing"}
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
                  rotateEnabled={false}
                  keepRatio={false}
                  ignoreStroke
                  flipEnabled={false}
                  anchorSize={8}
                  borderStroke="#2d8cff"
                  anchorStroke="#2d8cff"
                />
                {tool === "select" &&
                  selected &&
                  (selected.kind === "arrow" || selected.kind === "line") &&
                  ([0, 1] as const).map((end) => {
                    const s = (shown.find((sh) => sh.id === selected.id) ?? selected) as LineShape;
                    return (
                      <Circle
                        key={end}
                        x={s.points[end * 2]}
                        y={s.points[end * 2 + 1]}
                        radius={6 / zoom}
                        fill="#ffffff"
                        stroke="#2d8cff"
                        strokeWidth={1.5 / zoom}
                        draggable
                        onDragMove={(e) => setPreview(moveEndpoint(selected, end, e.target))}
                        onDragEnd={(e) => {
                          commit(moveEndpoint(selected, end, e.target));
                          setPreview(null);
                        }}
                      />
                    );
                  })}
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
  );
}
