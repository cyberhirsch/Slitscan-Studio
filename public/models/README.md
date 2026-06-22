# Neural models

Models are **downloaded on first use and cached in OPFS** (the browser's Origin
Private File System), not served from here. Clicking a neural engine button
fetches its model from a public CORS-enabled URL (see `MODEL_URLS` in
`src/neural.ts`) and stores it as `models/<engine>.onnx` in OPFS. Subsequent runs
load from OPFS with no network; it persists across reloads.

Currently wired:

| Engine | OPFS file     | Source |
|--------|---------------|--------|
| RIFE   | `rife.onnx`   | huggingface.co/yuvraj108c/rife-onnx (rife47, ~21 MB) |

Add GIMM-VFI / PerVFI / FILM by adding a public CORS URL to `MODEL_URLS`.

**I/O contract** (best-effort, introspected at load — see `src/neural.ts`):
- inputs: two RGB frames `[1,3,H,W]` in 0..1 (matched by `0`/`1` in the name),
  plus an optional timestep scalar (matched by `t`/`time`/`step`).
- output: interpolated RGB frame `[1,3,H,W]` in 0..1 (first output).

Inference runs at a capped resolution (≤512 long side, multiple of 32). Input/output
names are logged on load so a differing model can be adapted.

This `public/models/` directory is no longer the load path (kept for reference).
