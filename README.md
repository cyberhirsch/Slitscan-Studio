# Slitscan Studio

Browser-based, non-destructive **slit-scan workstation**. Import video, position a slit, and
render to any aspect ratio with motion-compensated temporal interpolation — entirely
client-side (WebCodecs · WebGPU · opencv.js · ONNX Runtime Web).

## Features

- Video import + frame scrubbing, plus a procedural demo source (no file needed).
- Click-to-place slit, 90° rotate, aspect-ratio fit.
- **Interpolate-then-slit** pipeline with selectable engines:
  - **Linear** — cross-fade baseline.
  - **DIS / DIS↓** — opencv.js dense optical flow (full-res / ¼-res for 4K), motion-compensated.
  - **Neural (RIFE)** — ONNX Runtime Web (WebGPU→WASM); more engines stubbed.
- **Model caching in OPFS** — neural models download once on first engine click and persist in
  the browser's Origin Private File System; no weights are committed.
- PNG export and an **interpolation-debug player** (scrub the synthesized in-between frames).
- Desaturated TUI.

## Run

```bash
npm install
npm run dev
```

Open the printed `localhost` URL.

## Design / status

See [host-app.md](host-app.md). The Android capture companion ("Slitscanner") is a separate project.

## Notes

- `public/sample.mp4` (test footage) is gitignored; the app falls back to the synthetic demo source.
- Neural inference runs at native resolution; on 4K this is heavy — use **DIS↓** for fast 4K.
