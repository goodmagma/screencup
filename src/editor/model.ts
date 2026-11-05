/**
 * Annotation model. Coordinates are in image pixels, independent of the editor zoom, so a
 * saved `Annotations` document re-renders identically on any screen.
 */

export type Tool = "select" | "arrow" | "line" | "rect" | "ellipse" | "highlight" | "blur" | "text" | "step";

interface Base {
  id: string;
  color: string;
  /** Stroke width in image pixels; text size and step badge size derive from it. */
  width: number;
}

export type LineShape = Base & { kind: "arrow" | "line"; points: [number, number, number, number] };
export type BoxShape = Base & { kind: "rect" | "ellipse" | "highlight" | "blur"; x: number; y: number; w: number; h: number };
export type TextShape = Base & { kind: "text"; x: number; y: number; text: string };
export type StepShape = Base & { kind: "step"; x: number; y: number; n: number };
export type Shape = LineShape | BoxShape | TextShape | StepShape;

/** Stored as `<library>/.originals/<name>.json`. */
export interface Annotations {
  version: 1;
  shapes: Shape[];
}

export const COLORS = ["#e5484d", "#f76b15", "#ffc53d", "#30a46c", "#2d8cff", "#8e4ec6", "#1c1f24", "#ffffff"];

/** Stroke widths for the S / M / L / XL buttons, before scaling to the image size. */
export const SIZES = [2, 4, 7, 12];

export const TOOLS: { tool: Tool; label: string; key: string }[] = [
  { tool: "select", label: "Select", key: "v" },
  { tool: "arrow", label: "Arrow", key: "a" },
  { tool: "line", label: "Line", key: "l" },
  { tool: "rect", label: "Rectangle", key: "r" },
  { tool: "ellipse", label: "Ellipse", key: "e" },
  { tool: "highlight", label: "Highlight", key: "h" },
  { tool: "blur", label: "Blur", key: "b" },
  { tool: "text", label: "Text", key: "t" },
  { tool: "step", label: "Step", key: "n" },
];

/** Keeps annotation sizes readable on large captures: 1 up to ~1600px, growing beyond. */
export const sizeScale = (imgW: number, imgH: number) => Math.max(1, Math.max(imgW, imgH) / 1600);

export const fontSize = (width: number) => 10 + width * 3.5;
export const stepRadius = (width: number) => 9 + width * 2;

export const isBox = (s: Shape): s is BoxShape =>
  s.kind === "rect" || s.kind === "ellipse" || s.kind === "highlight" || s.kind === "blur";

/** Boxes drawn right-to-left or bottom-to-top get positive width/height. */
export function normalizeBox(s: BoxShape): BoxShape {
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
  if (isBox(s)) return Math.abs(s.w) >= 4 && Math.abs(s.h) >= 4;
  return true;
}

/**
 * A copy of the image with coarse pixel blocks. Blur shapes show this copy clipped to their
 * box, so the exported PNG really contains destroyed pixels, not a reversible overlay.
 */
export function pixelate(img: HTMLImageElement): HTMLCanvasElement {
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

/** Undo/redo over immutable snapshots of the shape list. */
export interface History {
  stack: Shape[][];
  index: number;
}

export const historyOf = (shapes: Shape[]): History => ({ stack: [shapes], index: 0 });

export const push = (h: History, shapes: Shape[]): History => ({
  stack: [...h.stack.slice(0, h.index + 1), shapes],
  index: h.index + 1,
});
