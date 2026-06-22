// Optical flow via opencv.js (lazy-loaded WASM). Used by the DIS engine.
// Prefers DISOpticalFlow; falls back to Farneback if the build lacks DIS.
// @ts-ignore - opencv-js may not ship complete type declarations
import cvModule from "@techstark/opencv-js";

const cv: any = cvModule as any;

let ready: Promise<void> | null = null;

/** Resolve when the opencv WASM runtime is initialized. */
export function ensureCv(): Promise<void> {
  if (!ready) {
    ready = new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (cv && cv.Mat) { resolve(); return; }
        if (Date.now() - start > 20000) { reject(new Error("opencv.js load timeout")); return; }
        setTimeout(check, 50);
      };
      // emscripten hook (no-op if already initialized)
      try { cv.onRuntimeInitialized = () => resolve(); } catch { /* ignore */ }
      check();
    });
  }
  return ready;
}

export interface FlowResult {
  flow: Float32Array; // (u,v) per pixel at the (possibly downscaled) resolution
  w: number;
  h: number;
}

/**
 * Dense flow A→B. With `downscale > 1` the flow is computed on a reduced-res
 * grayscale (much faster, ~quadratic) and returned at that resolution — the
 * caller scales sample coords and vectors back up. Flow is smooth, so this
 * costs little quality and makes 4K practical.
 */
export async function computeFlow(a: ImageData, b: ImageData, downscale = 1): Promise<FlowResult> {
  await ensureCv();

  let matA = cv.matFromImageData(a);
  let matB = cv.matFromImageData(b);
  const garbage: any[] = [matA, matB];
  let w = a.width, h = a.height;

  if (downscale > 1) {
    const dw = Math.max(16, Math.round(w / downscale));
    const dh = Math.max(16, Math.round(h / downscale));
    const sa = new cv.Mat();
    const sb = new cv.Mat();
    cv.resize(matA, sa, new cv.Size(dw, dh), 0, 0, cv.INTER_AREA);
    cv.resize(matB, sb, new cv.Size(dw, dh), 0, 0, cv.INTER_AREA);
    matA = sa; matB = sb; w = dw; h = dh;
    garbage.push(sa, sb);
  }

  const grayA = new cv.Mat();
  const grayB = new cv.Mat();
  const flow = new cv.Mat();
  try {
    cv.cvtColor(matA, grayA, cv.COLOR_RGBA2GRAY);
    cv.cvtColor(matB, grayB, cv.COLOR_RGBA2GRAY);

    let usedDis = false;
    const DIS = cv.DISOpticalFlow;
    if (DIS && typeof DIS.create === "function") {
      try {
        const dis = DIS.create(1); // PRESET_FAST
        dis.calc(grayA, grayB, flow);
        if (typeof dis.delete === "function") dis.delete();
        usedDis = true;
      } catch { usedDis = false; }
    }
    if (!usedDis) {
      // pyrScale, levels, winsize, iterations, polyN, polySigma, flags
      cv.calcOpticalFlowFarneback(grayA, grayB, flow, 0.5, 3, 15, 3, 5, 1.2, 0);
    }
    return { flow: new Float32Array(flow.data32F), w, h }; // copy out of WASM heap
  } finally {
    for (const m of garbage) m.delete();
    grayA.delete(); grayB.delete(); flow.delete();
  }
}
