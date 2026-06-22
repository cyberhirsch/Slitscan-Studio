# Slitscan Studio — Host App Design

Desktop/browser companion to the Slitscanner mobile app. A non-destructive slit-scan
**workstation**: import video (or mobile scan bundles), define segments, stabilize, position
the slit, neural-interpolate, and render to any aspect ratio. Does the heavy lifting the phone
can't — full-frame neural interpolation.

---

## Runtime: browser-first

Runs **in the browser**, no install:
- **WebCodecs** — frame-accurate, hardware-accelerated video decode (`VideoDecoder`/`VideoFrame`).
- **WebGPU** — compute shaders for optical-flow warps, slit extraction, stabilization warps.
- **ONNX Runtime Web** (WebGPU execution provider) — neural interpolation models exported to ONNX.
- **opencv.js** (WASM) — DIS optical flow + image-based stabilization for the fast/preview path.
- **File System Access API** — open videos/bundles, write rendered outputs.

**Limit:** heavy neural 4K *final* renders are far slower in-browser than native CUDA.
**Upgrade path (no UI rewrite):** wrap in **Tauri** (Rust shell, native GPU) or run a tiny local
**Python engine** (FastAPI + PyTorch) that the web UI calls over localhost for final renders.
Preview/DIS always stays client-side.

**Stack:** Vite + TypeScript, Canvas/WebGPU for rendering. Lean dependencies.

---

## Design language: desaturated TUI

Terminal aesthetic, deliberately muted:
- Monospace throughout (`ui-monospace`, JetBrains/IBM Plex Mono).
- **Desaturated** palette — charcoal bg, low-saturation grey fg, muted sage/amber accents. No
  pure colors, no gradients, no shadows, no rounded corners.
- Box-drawing borders, bracketed panel labels `[ GALLERY ]`, keyboard-first, status line at
  bottom. Panels: Gallery · Source/Preview · Recipe · Timeline · Status.

---

## Core model: non-destructive sources + recipes

Everything is **a source = frame sequence + metadata**. Two flavors with different freedoms:
- **Full-frame video / image sequence** — slit anywhere, any angle/width; image-based stabilize;
  full-frame neural interpolation. The premium input.
- **Phone strip bundle** (`.bin` + `manifest.json`) — slit pre-baked in the 128px window
  (nudge ±64px, width ≤128); stabilize via saved gyro; interpolate. Constrained case of the same
  pipeline.

**Non-destructive, recipe-based** (Lightroom model): the source is never modified. You attach
**recipes** to it — `{ inOut, slit{pos,angle,width}, rotate, stabilize, aspectRatio, engine }`.
One source → many recipes → many rendered scans. Gallery shows sources *and* outputs; any recipe
re-renders on demand. Multiple in/out ranges = multiple recipes from one decode.

---

## Pipeline (order matters — interpolate THEN slit)

```
decode → stabilize → rotate → interpolate full frames → extract slit per frame → stack → AR
```

The locked decision: **interpolate full frames first, extract the slit second.** Synthesizing
whole in-between frames (full motion context, neural) and *then* taking one slit column from each
is dramatically better than interpolating a thin column sequence. The aspect ratio sets the
target frame count N′ (= output width); interpolation produces N′ frames; one slit column from
each → a stack of width N′ that already fits the AR. No separate "fill" step.

- **Stabilize:** gyro track (bundles, clean) or image-based trajectory smoothing (video,
  opencv.js). High-pass — kill jitter, keep the intended pan. Before slitting.
- **Rotate:** align source so the scan axis sits where you want (rotate source + axis-aligned
  slit = angled slit); plus output orientation. In source space, before slitting.
- **Slit:** position across frame, angle, width. Static now; sweeping slit later.
- **AR / interpolation:** with full-frame video you usually have many real frames, so filling an
  AR needs only modest interpolation (~3×) vs the phone's ~28×. Sweet spot: shoot **high-fps
  source (120/240)** → near-zero interpolation guesswork.

---

## Interpolation engines (swappable)

Runtime-selectable via an `Interpolator` plugin interface, **two-phase** (prepare once → sample
many t) so AR scrubbing stays interactive:

```ts
interface Interpolator {
  name: string;
  supportsArbitraryT: boolean;   // GIMM/RIFE/M2M = true; FILM = recursive midpoint only
  nativeMultiT: boolean;         // many t cheaply from one prepare()
  prepare(a: Frame, b: Frame): Promise<Ctx>;   // expensive: flow/features
  sample(ctx: Ctx, t: number): Promise<Frame>; // cheap per-t; host crops the slit
}
```

Shortlist (current SOTA, ATFI + large-motion subset — the relevant one for slit-scan):
- **DIS** (opencv.js) — not neural; instant preview/scrub. Always client-side.
- **RIFE v4** (ONNX) — fast preview tier, arbitrary-t, easy export.
- **GIMM-VFI** — arbitrary-t implicit motion; best conceptual fit for fractional-t fills.
  <https://github.com/GSeanCDAT/GIMM-VFI>
- **PerVFI** — perception-oriented VFI, robust to large motion/blur (asymmetric blending).
  <https://github.com/mulns/PerVFI>
- **BiFormer / VFIMamba / M2M-PWC** — large-motion 4K leaders (X4K1000FPS) for finals.
- **FILM** — low-fps / big-gap specialist (recursive, less ideal for fine t).
- **RDVFI / diffusion** — experimental max-quality tier (slow); native engine only.

Each backend is a thin adapter over its ONNX/PyTorch weights; the pipeline never changes when you
swap. A registry (`register("rife", …)`) + capability flags lets the UI grey out unsupported
modes and A/B engines on one recipe.

---

## Import / export
- **Import:** video (WebCodecs), image sequence, phone bundle (`manifest.json` + raw RGB `.bin`,
  `np`-style `reshape(N,H,W,3)`), incl. its gyro + per-frame timestamps.
- **Export:** rendered scan (PNG/TIFF for stills; optionally a "scan video"). Recipes persist in a
  project file so renders are reproducible.

---

## Performance tiers
- **Preview:** DIS (opencv.js/WebGPU), low-res, real-time scrub of slit/in-out/AR.
- **Final:** neural via ONNX Runtime Web (WebGPU) in-browser, or local Python engine / Tauri for
  native GPU on big 4K jobs. Queue + progress, like the phone gallery.

---

## Milestones
1. ✅ **Shell + TUI** — layout, gallery (list/grid + thumbnails), panels, status, keyboard nav,
   source/recipe data model.
2. ✅ **Import + decode** — video decode + frame scrub. Uses `<video>` + seek/draw (no demuxer;
   WebCodecs+mp4box is the precision/speed upgrade). Procedural `SyntheticFrameSource` demo so
   the pipeline runs without a file. Phone-bundle parser deferred (ignored for now per request).
3. ✅ **Slit + stack** — slit positioning (click), rotate (90° steps), AR fit, **interpolate-then-
   slit pipeline**, live preview, PNG export, result modal. Engines: **Linear** (cross-fade) and
   **DIS** (opencv.js dense flow → motion-compensated column warp, verified). opencv lazy-loads
   on first DIS use; Farneback fallback if the build lacks DIS.
   *Remaining:* image-based stabilize, angled/horizontal slit.
   Engines now also include **DIS↓** (flow on ¼-res, ~16× faster — for 4K).
4. ✅ **Neural engines (RIFE)** — ONNX Runtime Web (WebGPU→WASM), `src/neural.ts`, interpolate-
   then-slit at a ≤512px cap. Model downloads once on engine-button click and caches to **OPFS**
   (File System Access API, `src/model-store.ts`) — persists, cache-hit on re-click, graceful
   error reporting. **Inference verified end-to-end** on rife47 (inputs `img0`/`img1`/`timestep`
   → `output`; real timestep ⇒ arbitrary-t works) — clean slit-scans, no I/O adaptation needed.
   *Next:* GIMM-VFI/PerVFI/FILM URLs + per-model I/O adapters; raise the ≤512 neural cap for full
   spatial res at 4K (currently the neural path's main quality limit); WebGPU perf tuning.
5. ⬜ **Native engine (optional)** — Tauri wrap or local Python for fast 4K finals.

## Decisions / status
- **Framework:** vanilla TS + Vite (lean, fits the TUI). Project in `host/`.
- **Decode:** `<video>`+seek now; WebCodecs later for frame-accuracy + speed.
- Open: output formats beyond PNG (TIFF/EXR? scan video?); recipe persistence (project file);
  multiple-recipe UI (one source → many scans).
