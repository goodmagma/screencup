/**
 * Annotation model. Coordinates are in image pixels, independent of the editor zoom, so a
 * saved `Annotations` document re-renders identically on any screen.
 */

export type Tool =
  | "select"
  | "arrow"
  | "line"
  | "pen"
  | "polygon"
  | "callout"
  | "brace"
  | "rect"
  | "ellipse"
  | "highlight"
  | "blur"
  | "magnify"
  | "text"
  | "step"
  | "crop";

interface Base {
  id: string;
  color: string;
  /** Stroke width in image pixels; text size and step badge size derive from it. */
  width: number;
}

export type LineShape = Base & { kind: "arrow" | "line"; points: [number, number, number, number] };
/** Freehand stroke: x, y pairs. */
export type PenShape = Base & { kind: "pen"; points: number[] };
/** Closed outline through the clicked vertices: x, y pairs. */
export type PolygonShape = Base & { kind: "polygon"; points: number[] };
/** Speech balloon: a filled rounded box with text, and a tail pointing at (tx, ty). */
export type CalloutShape = Base & {
  kind: "callout";
  x: number;
  y: number;
  w: number;
  h: number;
  tx: number;
  ty: number;
  text: string;
};
export type BoxShape = Base & {
  /** "magnify": an ellipse showing the image under it at `MAGNIFY_ZOOM`; "brace": a curly
   * brace spanning the box height, pointing right before rotation; "image": a picture pasted
   * from the clipboard (Ctrl+V), stored in `src`. */
  kind: "rect" | "ellipse" | "highlight" | "blur" | "magnify" | "brace" | "image";
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees, clockwise. Blur and magnify are never rotated: they show the image beneath. */
  rotation?: number;
  /** "image" only: the picture as a PNG data URL, so the annotations file is self-contained. */
  src?: string;
};
export type TextShape = Base & { kind: "text"; x: number; y: number; text: string; rotation?: number };
export type StepShape = Base & { kind: "step"; x: number; y: number; n: number };
export type Shape = LineShape | PenShape | PolygonShape | CalloutShape | BoxShape | TextShape | StepShape;

/** Part of the source image kept, in source pixels. */
export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * What the editor edits and undoes: the shapes plus the crop and the output scale. Crop and
 * scale only apply when flattening, so they stay reversible after saving.
 */
export interface Doc {
  shapes: Shape[];
  crop?: Crop;
  /** Output size relative to the crop, 1 = unchanged. */
  scale?: number;
}

/** Stored as `<library>/.originals/<name>.json`. `crop` and `scale` arrived in 0.1.1. */
export interface Annotations {
  version: 1;
  shapes: Shape[];
  crop?: Crop;
  scale?: number;
}

/** Magnification of the magnify shape. */
export const MAGNIFY_ZOOM = 2;

export const COLORS = ["#e5484d", "#f76b15", "#ffc53d", "#30a46c", "#2d8cff", "#8e4ec6", "#1c1f24", "#ffffff"];

/** Stroke widths for the S / M / L / XL buttons, before scaling to the image size. */
export const SIZES = [2, 4, 7, 12];

export const TOOLS: { tool: Tool; key: string }[] = [
  { tool: "select", key: "v" },
  { tool: "arrow", key: "a" },
  { tool: "line", key: "l" },
  { tool: "rect", key: "r" },
  { tool: "text", key: "t" },
  { tool: "callout", key: "k" },
  { tool: "ellipse", key: "e" },
  { tool: "polygon", key: "g" },
  { tool: "step", key: "n" },
  { tool: "highlight", key: "h" },
  { tool: "pen", key: "p" },
  { tool: "blur", key: "b" },
  { tool: "magnify", key: "m" },
  { tool: "crop", key: "c" },
  { tool: "brace", key: "q" },
];

/** Keeps annotation sizes readable on large captures: 1 up to ~1600px, growing beyond. */
export const sizeScale = (imgW: number, imgH: number) => Math.max(1, Math.max(imgW, imgH) / 1600);

export const fontSize = (width: number) => 10 + width * 3.5;
export const stepRadius = (width: number) => 9 + width * 2;

/** Angle step of Shift-constrained lines, as in graphics editors. */
const SNAP_ANGLE = Math.PI / 12;

/** Shift while drawing a line: (x, y) turned around (x0, y0) onto the nearest 15° direction. */
export function snapAngle(x0: number, y0: number, x: number, y: number): [number, number] {
  const length = Math.hypot(x - x0, y - y0);
  const angle = Math.round(Math.atan2(y - y0, x - x0) / SNAP_ANGLE) * SNAP_ANGLE;
  return [x0 + length * Math.cos(angle), y0 + length * Math.sin(angle)];
}

/** Shift (or Alt) while drawing a box: equal sides, keeping the drag direction. */
export function squareOff(w: number, h: number): [number, number] {
  const side = Math.max(Math.abs(w), Math.abs(h));
  return [(w < 0 ? -1 : 1) * side, (h < 0 ? -1 : 1) * side];
}

export const isBox = (s: Shape): s is BoxShape =>
  s.kind === "rect" ||
  s.kind === "ellipse" ||
  s.kind === "highlight" ||
  s.kind === "blur" ||
  s.kind === "magnify" ||
  s.kind === "brace" ||
  s.kind === "image";

/** Box shapes positioned by their centre in Konva (ellipses). */
export const isCentred = (s: Shape): s is BoxShape => s.kind === "ellipse" || s.kind === "magnify";

/** Boxes drawn right-to-left or bottom-to-top get positive width/height. */
export function normalizeBox<T extends { x: number; y: number; w: number; h: number }>(s: T): T {
  return {
    ...s,
    x: Math.min(s.x, s.x + s.w),
    y: Math.min(s.y, s.y + s.h),
    w: Math.abs(s.w),
    h: Math.abs(s.h),
  };
}

/** Whether a freshly drawn shape is big enough to keep (a stray click draws nothing). */
export function isMeaningful(s: Shape): boolean {
  if (s.kind === "arrow" || s.kind === "line") {
    const [x1, y1, x2, y2] = s.points;
    return Math.hypot(x2 - x1, y2 - y1) >= 4;
  }
  if (s.kind === "pen") return s.points.length >= 4;
  if (s.kind === "polygon") return s.points.length >= 6;
  if (s.kind === "callout") return Math.abs(s.w) >= 4 && Math.abs(s.h) >= 4;
  if (isBox(s)) return Math.abs(s.w) >= 4 && Math.abs(s.h) >= 4;
  return true;
}

/**
 * A copy of the image with coarse pixel blocks. Blur shapes show this copy clipped to their
 * box, so the exported PNG really contains destroyed pixels, not a reversible overlay.
 */
export function pixelate(img: HTMLImageElement | HTMLCanvasElement): HTMLCanvasElement {
  const block = Math.max(8, Math.round(Math.max(img.width, img.height) / 160));
  const small = document.createElement("canvas");
  small.width = Math.max(1, Math.ceil(img.width / block));
  small.height = Math.max(1, Math.ceil(img.height / block));
  small.getContext("2d")!.drawImage(img, 0, 0, small.width, small.height);
  const out = document.createElement("canvas");
  out.width = img.width;
  out.height = img.height;
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, small.width * block, small.height * block);
  return out;
}

/** Undo/redo over immutable document snapshots. */
export interface History {
  stack: Doc[];
  index: number;
}

export const historyOf = (doc: Doc): History => ({ stack: [doc], index: 0 });

export const push = (h: History, doc: Doc): History => ({
  stack: [...h.stack.slice(0, h.index + 1), doc],
  index: h.index + 1,
});
