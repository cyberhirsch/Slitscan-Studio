// Slitscan Studio — core data model + interpolation plugin interface.
// See host-app.md for the full design.

export type SourceKind = "video" | "imageSequence" | "phoneBundle";

export interface SourceMeta {
  width: number;       // frame width in px (128 for phone bundles)
  height: number;      // frame height in px (sensor long side for bundles)
  frameCount: number;
  fps: number;
  hasGyro: boolean;    // phone bundles carry a gyro track for stabilization
}

/** Runtime decoder backing a Source. Draws frame `index` into a 2D context. */
export interface FrameSource {
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  readonly fps: number;
  drawFrame(index: number, ctx: CanvasRenderingContext2D, w: number, h: number): Promise<void>;
}

export type SlitAxis = "vertical" | "horizontal";

export interface Recipe {
  id: string;
  label: string;
  inFrame: number;
  outFrame: number;
  slit: { posNorm: number; angleDeg: number; widthPx: number; axis: SlitAxis };
  rotateDeg: number;
  stabilize: { enabled: boolean; mode: "gyro" | "image"; strength: number };
  aspectRatio: string; // "16:9" | "1:1" | "9:16" | "4:3" | "3:2" | "free"
  engine: string;      // Interpolator name
}

export interface Source {
  id: string;
  name: string;
  kind: SourceKind;
  meta: SourceMeta;
  recipes: Recipe[];
  fsrc?: FrameSource; // runtime decoder (not serialized)
}

// ---- Interpolation backends (swappable) -----------------------------------
// Two-phase so AR scrubbing stays interactive: prepare() once (expensive
// flow/features), sample(t) cheap per fractional time. Host crops the slit
// from the returned full frame (interpolate-THEN-slit).

export interface Frame {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA
}

export interface Interpolator {
  readonly name: string;
  readonly supportsArbitraryT: boolean; // GIMM/RIFE/M2M = true; FILM = recursive
  readonly nativeMultiT: boolean;        // many t cheaply from one prepare()
  prepare(a: Frame, b: Frame): Promise<unknown>;
  sample(ctx: unknown, t: number): Promise<Frame>;
}

const registry = new Map<string, Interpolator>();
export function registerInterpolator(i: Interpolator): void { registry.set(i.name, i); }
export function getInterpolator(name: string): Interpolator | undefined { return registry.get(name); }
export function listInterpolators(): Interpolator[] { return [...registry.values()]; }

// Stub backends so the UI can list/select engines. sample() is wired in
// milestone 3 (DIS via opencv.js) and milestone 4 (RIFE/GIMM via ONNX Runtime Web).
function stub(name: string, supportsArbitraryT: boolean, nativeMultiT: boolean): Interpolator {
  return {
    name, supportsArbitraryT, nativeMultiT,
    async prepare() { return null; },
    async sample(): Promise<Frame> { throw new Error(`${name}: not implemented yet`); },
  };
}
registerInterpolator(stub("Linear", true, true));     // built-in baseline (handled inline in pipeline)
registerInterpolator(stub("DIS", true, true));        // opencv.js — full-res dense flow
registerInterpolator(stub("DIS↓", true, true));       // opencv.js — flow on ¼-res (fast, for 4K)
registerInterpolator(stub("RIFE", true, true));       // ONNX — fast neural
registerInterpolator(stub("GIMM-VFI", true, true));   // arbitrary-t neural (github GSeanCDAT/GIMM-VFI)
registerInterpolator(stub("PerVFI", true, false));    // perception-oriented (github mulns/PerVFI)
registerInterpolator(stub("FILM", false, false));     // large-motion specialist

// ---- helpers ---------------------------------------------------------------

/** Target output width (= time columns = frame count after interpolation). */
export function targetWidth(aspectRatio: string, height: number, frameCount: number): number {
  if (aspectRatio === "free") return frameCount;
  const [w, h] = aspectRatio.split(":").map(Number);
  if (!w || !h) return frameCount;
  return Math.round(height * (w / h));
}

/** How hard the interpolation works: synthesized columns per real frame. */
export function interpRatio(target: number, activeFrames: number): number {
  if (activeFrames <= 1) return target;
  return target / activeFrames;
}
