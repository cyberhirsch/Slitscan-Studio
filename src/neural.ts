// Neural frame interpolation via ONNX Runtime Web (WebGPU, WASM fallback).
// Models download once on first use and are cached in OPFS (see model-store.ts);
// subsequent runs load from local storage with no network.
//
// I/O contract (best-effort, introspected at load):
//   inputs : two RGB frames [1,3,H,W] in 0..1, names matched by "0"/"1";
//            an optional timestep scalar/[1] matched by "t"/"time"/"step".
//   output : interpolated RGB frame [1,3,H,W] in 0..1 (first output).

import { modelExists, modelSize, readModel, downloadModel } from "./model-store";

let ortMod: any = null;
const ORT_VERSION = "1.27.0";

async function getOrt(): Promise<any> {
  if (!ortMod) {
    ortMod = await import("onnxruntime-web");
    ortMod.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
  }
  return ortMod;
}

// Download URLs per engine (public + CORS-enabled). Add others as sourced.
const MODEL_URLS: Record<string, string> = {
  "RIFE": "https://huggingface.co/yuvraj108c/rife-onnx/resolve/main/rife47_ensemble_True_scale_1_sim.onnx",
};

export function modelFilename(engine: string): string {
  return `${engine.toLowerCase().replace(/[^a-z0-9]/g, "")}.onnx`;
}
export function hasUrl(engine: string): boolean { return !!MODEL_URLS[engine]; }
export function isCached(engine: string): Promise<boolean> { return modelExists(modelFilename(engine)); }
export function cachedSize(engine: string): Promise<number> { return modelSize(modelFilename(engine)); }

// Ensure the model bytes are present (download to OPFS if needed). Deduped.
const inflight = new Map<string, Promise<ArrayBuffer>>();
export function ensureModelBytes(engine: string, onProgress: (p: number) => void = () => {}): Promise<ArrayBuffer> {
  let p = inflight.get(engine);
  if (!p) {
    const file = modelFilename(engine);
    p = (async () => {
      if (await modelExists(file)) return readModel(file);
      const url = MODEL_URLS[engine];
      if (!url) throw new Error(`no download URL configured (drop ${file} in OPFS or public/models)`);
      try { await navigator.storage?.persist?.(); } catch { /* best-effort */ }
      await downloadModel(file, url, onProgress);
      return readModel(file);
    })();
    inflight.set(engine, p);
    void p.finally(() => inflight.delete(engine));
  }
  return p;
}

export interface ModelInfo { inputs: string[]; outputs: string[] }

let activeSession: any = null;
const sessions = new Map<string, any>();

/** Ensure model is cached + an ORT session exists; make it the active engine. */
export async function getSession(engine: string, onProgress?: (p: number) => void): Promise<ModelInfo> {
  let s = sessions.get(engine);
  if (!s) {
    const bytes = await ensureModelBytes(engine, onProgress);
    const ort = await getOrt();
    const data = new Uint8Array(bytes);
    try {
      s = await ort.InferenceSession.create(data, { executionProviders: ["webgpu", "wasm"] });
    } catch {
      s = await ort.InferenceSession.create(data, { executionProviders: ["wasm"] });
    }
    sessions.set(engine, s);
    console.log(`[neural] ${engine} session ready — inputs ${JSON.stringify(s.inputNames)} outputs ${JSON.stringify(s.outputNames)}`);
  }
  activeSession = s;
  return { inputs: s.inputNames, outputs: s.outputNames };
}

/** ImageData (RGBA) -> NCHW Float32 [1,3,h,w], normalized 0..1. */
function toTensor(ort: any, img: ImageData): any {
  const { width: w, height: h, data } = img;
  const out = new Float32Array(3 * w * h);
  const plane = w * h;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    out[p] = data[i] / 255;
    out[plane + p] = data[i + 1] / 255;
    out[2 * plane + p] = data[i + 2] / 255;
  }
  return new ort.Tensor("float32", out, [1, 3, h, w]);
}

/** NCHW Float32 [1,3,h,w] (0..1) -> ImageData. */
function toImageData(t: any, w: number, h: number): ImageData {
  const d = t.data as Float32Array;
  const plane = w * h;
  const out = new ImageData(w, h);
  for (let p = 0, i = 0; p < plane; p++, i += 4) {
    out.data[i] = Math.max(0, Math.min(255, d[p] * 255));
    out.data[i + 1] = Math.max(0, Math.min(255, d[plane + p] * 255));
    out.data[i + 2] = Math.max(0, Math.min(255, d[2 * plane + p] * 255));
    out.data[i + 3] = 255;
  }
  return out;
}

/** Interpolate the frame at fraction t between a and b (same dims, mult. of 32). */
export async function interpolateFrame(a: ImageData, b: ImageData, t: number): Promise<ImageData> {
  const ort = await getOrt();
  if (!activeSession) throw new Error("no model session");
  const w = a.width, h = a.height;
  const t0 = toTensor(ort, a);
  const t1 = toTensor(ort, b);

  const feeds: Record<string, any> = {};
  let img0Assigned = false;
  for (const name of activeSession.inputNames as string[]) {
    const n = name.toLowerCase();
    if (/time|timestep|step/.test(n) || n === "t") {
      feeds[name] = new ort.Tensor("float32", new Float32Array([t]), [1]);
    } else if (n.includes("1") && img0Assigned) {
      feeds[name] = t1;
    } else if (!img0Assigned) {
      feeds[name] = t0; img0Assigned = true;
    } else {
      feeds[name] = t1;
    }
  }

  const result = await activeSession.run(feeds);
  return toImageData(result[activeSession.outputNames[0]], w, h);
}
