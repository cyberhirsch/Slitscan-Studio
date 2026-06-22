import { Source, Recipe, FrameSource, targetWidth } from "./types";

/** Frame dims after a 90°-multiple rotation. */
export function rotatedDims(w: number, h: number, deg: number): [number, number] {
  const r = ((deg % 360) + 360) % 360;
  return r === 90 || r === 270 ? [h, w] : [w, h];
}

/** Render frame `index` into a canvas, rotated by `deg` about its centre. */
export async function renderRotatedFrame(
  fsrc: FrameSource, index: number, deg: number,
): Promise<HTMLCanvasElement> {
  const fw = fsrc.width, fh = fsrc.height;
  const frame = document.createElement("canvas");
  frame.width = fw; frame.height = fh;
  await fsrc.drawFrame(index, frame.getContext("2d")!, fw, fh);

  const r = ((deg % 360) + 360) % 360;
  if (r === 0) return frame;

  const [ow, oh] = rotatedDims(fw, fh, r);
  const out = document.createElement("canvas");
  out.width = ow; out.height = oh;
  const c = out.getContext("2d")!;
  c.translate(ow / 2, oh / 2);
  c.rotate((r * Math.PI) / 180);
  c.drawImage(frame, -fw / 2, -fh / 2);
  return out;
}

/** Bilinear RGB sample from an ImageData into out[0..2]. */
function bilin(img: ImageData, x: number, y: number, out: number[]): void {
  const w = img.width, h = img.height, d = img.data;
  if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0, fy = y - y0;
  const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
  for (let c = 0; c < 3; c++) {
    const top = d[i00 + c] * (1 - fx) + d[i10 + c] * fx;
    const bot = d[i01 + c] * (1 - fx) + d[i11 + c] * fx;
    out[c] = top * (1 - fy) + bot * fy;
  }
}

function downscaleImageData(img: ImageData, nw: number, nh: number): ImageData {
  const src = document.createElement("canvas");
  src.width = img.width; src.height = img.height;
  src.getContext("2d")!.putImageData(img, 0, 0);
  const dst = document.createElement("canvas");
  dst.width = nw; dst.height = nh;
  const c = dst.getContext("2d")!;
  c.drawImage(src, 0, 0, nw, nh);
  return c.getImageData(0, 0, nw, nh);
}

const NEURAL_ENGINES = new Set(["RIFE", "GIMM-VFI", "PerVFI", "FILM"]);

export function isNeuralEngine(name: string): boolean { return NEURAL_ENGINES.has(name); }

/** Round to a multiple of 32 (neural models typically require it). */
function mult32(n: number): number { return Math.max(32, Math.round(n / 32) * 32); }

/**
 * Build a slit-scan (interpolate-then-slit). Output width is set by the aspect
 * ratio. Per output column we pick a time, find bracketing frames a/b and
 * fraction f, then produce the slit column with the selected engine:
 *   - Linear : cross-fade the two slit columns.
 *   - DIS/DIS↓ : opencv dense flow A→B (full or ¼-res), motion-compensate the slit column.
 *   - neural : ONNX model synthesizes the in-between FRAME (capped res), then we slit it.
 */
export async function buildSlitScan(
  source: Source, recipe: Recipe, onProgress: (p: number) => void,
): Promise<HTMLCanvasElement> {
  const engine = recipe.engine;
  const isDis = engine === "DIS" || engine === "DIS↓";
  const isNeural = NEURAL_ENGINES.has(engine);
  if (engine !== "Linear" && !isDis && !isNeural) {
    throw new Error(`engine "${engine}" not wired yet`);
  }
  const fsrc = source.fsrc;
  if (!fsrc) throw new Error("source has no decoder");

  const deg = ((recipe.rotateDeg % 360) + 360) % 360;
  const [W0, H] = rotatedDims(fsrc.width, fsrc.height, deg);
  const slitX = Math.max(0, Math.min(W0 - 1, Math.round(recipe.slit.posNorm * W0)));

  const inF = Math.max(0, Math.min(recipe.inFrame, fsrc.frameCount - 1));
  const outF = Math.max(inF, Math.min(recipe.outFrame, fsrc.frameCount - 1));
  const activeN = outF - inF + 1;
  const W = Math.max(1, targetWidth(recipe.aspectRatio, H, activeN));

  // engine setup
  const flowDownscale = engine === "DIS↓" ? 4 : 1;
  let computeFlow: typeof import("./flow").computeFlow | null = null;
  if (isDis) computeFlow = (await import("./flow")).computeFlow;

  let neural: typeof import("./neural") | null = null;
  let nw = 0, nh = 0;
  if (isNeural) {
    neural = await import("./neural");
    try {
      await neural.getSession(engine);
    } catch (e) {
      throw new Error(`${engine}: ${(e as Error).message}`);
    }
    // cap removed — run neural at native resolution (rounded to a multiple of 32)
    nw = mult32(W0);
    nh = mult32(H);
    if (nw * nh > 4096 * 4096) console.warn(`[neural] large inference ${nw}x${nh} — may be slow / OOM`);
  }

  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const octx = out.getContext("2d")!;
  const img = octx.createImageData(W, H);
  const data = img.data;

  const frameCache = new Map<number, ImageData>();
  const getFrame = async (idx: number): Promise<ImageData> => {
    const hit = frameCache.get(idx);
    if (hit) return hit;
    const c = await renderRotatedFrame(fsrc, idx, deg);
    const d = c.getContext("2d")!.getImageData(0, 0, W0, H);
    frameCache.set(idx, d);
    for (const k of frameCache.keys()) if (k < idx - 1) frameCache.delete(k);
    return d;
  };
  const smallCache = new Map<number, ImageData>();
  const getSmall = async (idx: number): Promise<ImageData> => {
    const hit = smallCache.get(idx);
    if (hit) return hit;
    const d = downscaleImageData(await getFrame(idx), nw, nh);
    smallCache.set(idx, d);
    for (const k of smallCache.keys()) if (k < idx - 1) smallCache.delete(k);
    return d;
  };

  let flowPairA = -1;
  let flowCol: Float32Array | null = null;
  const sa: number[] = [0, 0, 0];
  const sb: number[] = [0, 0, 0];

  const writeExact = (fa: ImageData, col: number) => {
    for (let y = 0; y < H; y++) {
      const si = (y * W0 + slitX) * 4;
      const di = (y * W + col) * 4;
      data[di] = fa.data[si]; data[di + 1] = fa.data[si + 1];
      data[di + 2] = fa.data[si + 2]; data[di + 3] = 255;
    }
  };

  for (let col = 0; col < W; col++) {
    const tg = activeN === 1 ? inF : inF + (col * (activeN - 1)) / (W - 1);
    const a = Math.floor(tg);
    const f = tg - a;
    const b = Math.min(a + 1, outF);
    const fa = await getFrame(a);

    if (f < 1e-4 || b === a) {
      writeExact(fa, col);
    } else if (isNeural && neural) {
      const small = await neural.interpolateFrame(await getSmall(a), await getSmall(b), f);
      const sx = Math.max(0, Math.min(nw - 1, Math.round((slitX * nw) / W0)));
      for (let y = 0; y < H; y++) {
        bilin(small, sx, (y * (nh - 1)) / (H - 1), sa);
        const di = (y * W + col) * 4;
        data[di] = sa[0]; data[di + 1] = sa[1]; data[di + 2] = sa[2]; data[di + 3] = 255;
      }
    } else if (isDis && computeFlow) {
      const fb = await getFrame(b);
      if (a !== flowPairA) {
        const { flow, w: fw, h: fh } = await computeFlow(fa, fb, flowDownscale);
        const sxr = fw / W0, syr = fh / H;
        const vSx = W0 / fw, vSy = H / fh;
        const fc = new Float32Array(H * 2);
        for (let y = 0; y < H; y++) {
          const fx = Math.min(fw - 1, Math.max(0, Math.round(slitX * sxr)));
          const fy = Math.min(fh - 1, Math.max(0, Math.round(y * syr)));
          const fi = (fy * fw + fx) * 2;
          fc[y * 2] = flow[fi] * vSx;
          fc[y * 2 + 1] = flow[fi + 1] * vSy;
        }
        flowCol = fc; flowPairA = a;
      }
      const fc = flowCol!;
      for (let y = 0; y < H; y++) {
        const u = fc[y * 2], v = fc[y * 2 + 1];
        bilin(fa, slitX - f * u, y - f * v, sa);
        bilin(fb, slitX + (1 - f) * u, y + (1 - f) * v, sb);
        const di = (y * W + col) * 4;
        data[di] = (1 - f) * sa[0] + f * sb[0];
        data[di + 1] = (1 - f) * sa[1] + f * sb[1];
        data[di + 2] = (1 - f) * sa[2] + f * sb[2];
        data[di + 3] = 255;
      }
    } else {
      const fb = await getFrame(b);
      for (let y = 0; y < H; y++) {
        const si = (y * W0 + slitX) * 4;
        const di = (y * W + col) * 4;
        data[di] = fa.data[si] * (1 - f) + fb.data[si] * f;
        data[di + 1] = fa.data[si + 1] * (1 - f) + fb.data[si + 1] * f;
        data[di + 2] = fa.data[si + 2] * (1 - f) + fb.data[si + 2] * f;
        data[di + 3] = 255;
      }
    }

    if ((col & 15) === 0 || isNeural) {
      onProgress(col / W);
      await new Promise((r) => setTimeout(r));
    }
  }

  octx.putImageData(img, 0, 0);
  onProgress(1);
  return out;
}

// ---- debug: review the interpolated frames between two source frames -------

async function rotatedFrameImageData(
  fsrc: FrameSource, index: number, deg: number, w: number, h: number,
): Promise<ImageData> {
  const c = await renderRotatedFrame(fsrc, index, deg);
  const d = document.createElement("canvas");
  d.width = w; d.height = h;
  const ctx = d.getContext("2d")!;
  ctx.drawImage(c, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

function blendFull(a: ImageData, b: ImageData, t: number): ImageData {
  const out = new ImageData(a.width, a.height);
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = a.data[i] * (1 - t) + b.data[i] * t;
    out.data[i + 1] = a.data[i + 1] * (1 - t) + b.data[i + 1] * t;
    out.data[i + 2] = a.data[i + 2] * (1 - t) + b.data[i + 2] * t;
    out.data[i + 3] = 255;
  }
  return out;
}

function warpBlendFull(a: ImageData, b: ImageData, fr: { flow: Float32Array; w: number; h: number }, t: number): ImageData {
  const w = a.width, h = a.height;
  const out = new ImageData(w, h);
  const sxr = fr.w / w, syr = fr.h / h, vSx = w / fr.w, vSy = h / fr.h;
  const sa: number[] = [0, 0, 0], sb: number[] = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const fx = Math.min(fr.w - 1, Math.max(0, Math.round(x * sxr)));
      const fy = Math.min(fr.h - 1, Math.max(0, Math.round(y * syr)));
      const fi = (fy * fr.w + fx) * 2;
      const u = fr.flow[fi] * vSx, v = fr.flow[fi + 1] * vSy;
      bilin(a, x - t * u, y - t * v, sa);
      bilin(b, x + (1 - t) * u, y + (1 - t) * v, sb);
      const di = (y * w + x) * 4;
      out.data[di] = (1 - t) * sa[0] + t * sb[0];
      out.data[di + 1] = (1 - t) * sa[1] + t * sb[1];
      out.data[di + 2] = (1 - t) * sa[2] + t * sb[2];
      out.data[di + 3] = 255;
    }
  }
  return out;
}

export interface InterpSequence { frames: ImageData[]; ts: number[]; a: number; b: number; engine: string }

/**
 * Produce the full interpolated frames between source frame `a` and `a+1` at
 * `steps` substeps, using the recipe's engine — for visually debugging the
 * interpolation. Runs at a preview resolution (≤ maxSide) for speed.
 */
export async function interpolateSequence(
  source: Source, recipe: Recipe, frameA: number, steps: number, maxSide = 768,
): Promise<InterpSequence> {
  const fsrc = source.fsrc;
  if (!fsrc) throw new Error("source has no decoder");
  const engine = recipe.engine;
  const isNeural = NEURAL_ENGINES.has(engine);
  const deg = ((recipe.rotateDeg % 360) + 360) % 360;
  const [W0, H0] = rotatedDims(fsrc.width, fsrc.height, deg);
  const a = Math.max(0, Math.min(frameA, fsrc.frameCount - 1));
  const b = Math.min(a + 1, fsrc.frameCount - 1);

  const sc = Math.min(1, maxSide / Math.max(W0, H0));
  let pw = Math.max(8, Math.round(W0 * sc)), ph = Math.max(8, Math.round(H0 * sc));
  if (isNeural) { pw = mult32(pw); ph = mult32(ph); }

  const A = await rotatedFrameImageData(fsrc, a, deg, pw, ph);
  const B = await rotatedFrameImageData(fsrc, b, deg, pw, ph);

  let flow: { flow: Float32Array; w: number; h: number } | null = null;
  if (engine === "DIS" || engine === "DIS↓") {
    const cf = (await import("./flow")).computeFlow;
    flow = await cf(A, B, engine === "DIS↓" ? 4 : 1);
  }
  let neural: typeof import("./neural") | null = null;
  if (isNeural) { neural = await import("./neural"); await neural.getSession(engine); }

  const frames: ImageData[] = [];
  const ts: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    ts.push(t);
    if (t < 1e-6) frames.push(A);
    else if (t > 1 - 1e-6) frames.push(B);
    else if (isNeural && neural) frames.push(await neural.interpolateFrame(A, B, t));
    else if (flow) frames.push(warpBlendFull(A, B, flow, t));
    else frames.push(blendFull(A, B, t));
  }
  return { frames, ts, a, b, engine };
}
