import "./style.css";
import { Source, Recipe, listInterpolators, targetWidth, interpRatio } from "./types";
import { SyntheticFrameSource, VideoFrameSource } from "./decode";
import { renderRotatedFrame, rotatedDims, buildSlitScan, isNeuralEngine, interpolateSequence, InterpSequence } from "./pipeline";

const ASPECTS = ["16:9", "3:2", "4:3", "1:1", "9:16", "free"];

function defaultRecipe(id: string, frameCount: number): Recipe {
  return {
    id, label: "scan 1",
    inFrame: 0, outFrame: frameCount - 1,
    slit: { posNorm: 0.5, angleDeg: 0, widthPx: 1, axis: "vertical" },
    rotateDeg: 0,
    stabilize: { enabled: false, mode: "image", strength: 0.5 },
    aspectRatio: "16:9",
    engine: "Linear",
  };
}

function sourceFromFrameSource(id: string, name: string, kind: Source["kind"], fsrc: SyntheticFrameSource | VideoFrameSource): Source {
  return {
    id, name, kind,
    meta: { width: fsrc.width, height: fsrc.height, frameCount: fsrc.frameCount, fps: fsrc.fps, hasGyro: false },
    recipes: [defaultRecipe(id, fsrc.frameCount)],
    fsrc,
  };
}

const SOURCES: Source[] = [
  sourceFromFrameSource("demo", "demo_synthetic", "video", new SyntheticFrameSource()),
];

let activeId = SOURCES[0].id;
let viewMode: "list" | "grid" = "grid";
let curFrame = 0;
let busy = false;
let interpTimer: number | null = null;

const active = () => SOURCES.find((s) => s.id === activeId)!;
const activeRecipe = () => active().recipes[0];

const app = document.getElementById("app")!;

function kindTag(k: Source["kind"]): string {
  return k === "video" ? "vid" : k === "imageSequence" ? "seq" : "bnd";
}
function glyphFor(k: Source["kind"]): string {
  return k === "video" ? "►" : k === "imageSequence" ? "▦" : "▌";
}

// ---- render ----------------------------------------------------------------
function render(): void {
  const s = active();
  const r = activeRecipe();
  const af = r.outFrame - r.inFrame + 1;
  const [W0, H] = rotatedDims(s.meta.width, s.meta.height, r.rotateDeg);
  const tw = targetWidth(r.aspectRatio, H, af);
  const ratio = interpRatio(tw, af);
  const heavy = ratio > 10;
  curFrame = Math.max(r.inFrame, Math.min(r.outFrame, curFrame));

  app.innerHTML = `
    <header class="hdr">
      <span class="brand">SLITSCAN STUDIO</span>
      <nav class="nav">
        <button class="active">GALLERY</button>
        <button data-act="import">IMPORT</button>
        <button data-act="settings">SETTINGS</button>
      </nav>
      <span class="spacer"></span>
      <span class="engine">engine <b>${r.engine}</b></span>
    </header>

    <div class="main">
      <section class="panel gallery">
        <div class="panel-title">
          <span>[ gallery ]</span>
          <span class="view-toggle">
            <button data-view="list" class="${viewMode === "list" ? "active" : ""}">list</button>
            <button data-view="grid" class="${viewMode === "grid" ? "active" : ""}">grid</button>
          </span>
        </div>
        <div class="panel-body ${viewMode === "grid" ? "grid" : ""}">
          ${SOURCES.map((src) => viewMode === "grid" ? `
            <div class="card ${src.id === activeId ? "sel" : ""}" data-id="${src.id}">
              <div class="thumb ${kindTag(src.kind)}">
                <canvas class="thumb-cv" data-thumb="${src.id}"></canvas>
                <span class="glyph">${glyphFor(src.kind)}</span>
                <span class="dims">${src.meta.width}×${src.meta.height}</span>
              </div>
              <div class="cap">${src.name}</div>
            </div>` : `
            <div class="item ${src.id === activeId ? "sel" : ""}" data-id="${src.id}">
              <span class="caret"></span>
              <span class="kind">${kindTag(src.kind)}</span>
              <span class="nm">${src.name}</span>
            </div>`).join("")}
          <div class="${viewMode === "grid" ? "card add" : "item add"}" data-act="import">
            ${viewMode === "grid" ? `<div class="thumb"><span class="glyph">+</span></div><div class="cap">import video</div>` : `<span class="caret">+</span><span class="nm">import video</span>`}
          </div>
        </div>
      </section>

      <section class="panel preview">
        <div class="panel-title"><span>[ source / preview ]</span><span class="hint">click to set slit</span></div>
        <div class="panel-body pv-wrap">
          <div class="stage"><canvas id="pv"></canvas></div>
          <div class="pv-controls">
            <input type="range" id="scrub" min="0" max="${s.meta.frameCount - 1}" value="${curFrame}" />
            <div class="ctl-row">
              <span class="frm">f <span id="curf">${curFrame}</span>/${s.meta.frameCount - 1}</span>
              <button data-act="setin">[ in ]</button>
              <button data-act="setout">[ out ]</button>
              <span class="sep">│</span>
              <button data-act="rot">⟳ ${r.rotateDeg}°</button>
              <span class="spacer"></span>
              <button data-act="debug" ${busy ? "disabled" : ""}>interp dbg</button>
              <button data-act="render" class="primary" ${busy ? "disabled" : ""}>render ▶</button>
            </div>
            <div class="ctl-row wrap">
              <span class="lbl">ar</span>
              ${ASPECTS.map((a) => `<button data-ar="${a}" class="${r.aspectRatio === a ? "active" : ""}">${a}</button>`).join("")}
            </div>
            <div class="ctl-row wrap">
              <span class="lbl">engine</span>
              ${listInterpolators().map((i) => `<button data-eng="${i.name}" class="${r.engine === i.name ? "active" : ""} ${i.name === "Linear" ? "" : "soft"}">${i.name}</button>`).join("")}
            </div>
          </div>
        </div>
      </section>

      <section class="panel recipe">
        <div class="panel-title"><span>[ recipe ]</span></div>
        <div class="panel-body">
          <div class="sub">range</div>
          <div class="row"><span class="k">in / out</span><span class="v">${r.inFrame} → ${r.outFrame}</span></div>
          <div class="row"><span class="k">frames</span><span class="v">${af}</span></div>
          <div class="sub">slit</div>
          <div class="row"><span class="k">position</span><span class="v">${(r.slit.posNorm * 100).toFixed(1)}%</span></div>
          <div class="row"><span class="k">width</span><span class="v">${r.slit.widthPx}px</span></div>
          <div class="sub">transform</div>
          <div class="row"><span class="k">rotate</span><span class="v">${r.rotateDeg}°</span></div>
          <div class="row"><span class="k">stabilize</span><span class="v dim">${r.stabilize.enabled ? r.stabilize.mode : "off — todo"}</span></div>
          <div class="sub">output</div>
          <div class="row"><span class="k">aspect</span><span class="v">${r.aspectRatio}</span></div>
          <div class="row"><span class="k">size</span><span class="v">${tw}×${H}</span></div>
          <div class="row"><span class="k">engine</span><span class="v">${r.engine}</span></div>
        </div>
      </section>
    </div>

    <div class="timeline">
      <span class="label">TIMELINE</span>
      <div class="track" id="track">
        <div class="range" style="left:${(r.inFrame / s.meta.frameCount) * 100}%;width:${(af / s.meta.frameCount) * 100}%"></div>
        <div class="play" style="left:${(curFrame / s.meta.frameCount) * 100}%"></div>
      </div>
      <span class="nums">${r.inFrame}–${r.outFrame} / ${s.meta.frameCount}</span>
    </div>

    <footer class="status">
      <span class="dot">●</span><span id="st-msg">${busy ? "rendering…" : "ready"}</span>
      <span class="sep">│</span><span>${af} frames</span>
      <span class="sep">│</span><span>${H}px slit</span>
      <span class="sep">│</span>
      <span class="${heavy ? "warn" : ""}">interp ~${ratio.toFixed(1)}× ${heavy ? "(heavy)" : ""}</span>
    </footer>
  `;

  bind();
  void drawPreview();
  if (viewMode === "grid") void drawThumbs();
}

function setStatus(msg: string): void {
  const el = document.getElementById("st-msg");
  if (el) el.textContent = msg;
}

// ---- bindings --------------------------------------------------------------
function bind(): void {
  app.querySelectorAll<HTMLElement>(".gallery [data-id]").forEach((el) => {
    el.addEventListener("click", () => { activeId = el.dataset.id!; curFrame = activeRecipe().inFrame; render(); });
  });
  app.querySelectorAll<HTMLElement>(".view-toggle button").forEach((el) => {
    el.addEventListener("click", () => { viewMode = el.dataset.view as "list" | "grid"; render(); });
  });
  app.querySelectorAll<HTMLElement>('[data-act="import"]').forEach((el) => {
    el.addEventListener("click", importVideo);
  });
  app.querySelectorAll<HTMLElement>("[data-ar]").forEach((el) => {
    el.addEventListener("click", () => { activeRecipe().aspectRatio = el.dataset.ar!; render(); });
  });
  app.querySelectorAll<HTMLElement>("[data-eng]").forEach((el) => {
    el.addEventListener("click", () => {
      const eng = el.dataset.eng!;
      activeRecipe().engine = eng;
      render();
      if (isNeuralEngine(eng)) void prefetchModel(eng);
    });
  });

  document.getElementById("scrub")?.addEventListener("input", (e) => {
    curFrame = +(e.target as HTMLInputElement).value;
    const cf = document.getElementById("curf");
    if (cf) cf.textContent = String(curFrame);
    const play = app.querySelector<HTMLElement>(".timeline .play");
    if (play) play.style.left = `${(curFrame / active().meta.frameCount) * 100}%`;
    void drawPreview();
  });
  document.querySelector('[data-act="setin"]')?.addEventListener("click", () => { activeRecipe().inFrame = Math.min(curFrame, activeRecipe().outFrame); render(); });
  document.querySelector('[data-act="setout"]')?.addEventListener("click", () => { activeRecipe().outFrame = Math.max(curFrame, activeRecipe().inFrame); render(); });
  document.querySelector('[data-act="rot"]')?.addEventListener("click", () => { activeRecipe().rotateDeg = (activeRecipe().rotateDeg + 90) % 360; render(); });
  document.querySelector('[data-act="render"]')?.addEventListener("click", () => { void doRender(); });
  document.querySelector('[data-act="debug"]')?.addEventListener("click", () => { void doDebugInterp(); });

  const pv = document.getElementById("pv") as HTMLCanvasElement | null;
  pv?.addEventListener("click", (e) => {
    const rect = pv.getBoundingClientRect();
    activeRecipe().slit.posNorm = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    render();
  });
}

// ---- preview + thumbnails --------------------------------------------------
async function drawPreview(): Promise<void> {
  const s = active(), r = activeRecipe();
  const pv = document.getElementById("pv") as HTMLCanvasElement | null;
  if (!pv || !s.fsrc) return;
  const [rw, rh] = rotatedDims(s.fsrc.width, s.fsrc.height, r.rotateDeg);
  const cw = Math.min(1024, rw);
  const ch = Math.round((cw * rh) / rw);
  pv.width = cw; pv.height = ch;
  const ctx = pv.getContext("2d")!;
  const frame = await renderRotatedFrame(s.fsrc, curFrame, r.rotateDeg);
  ctx.drawImage(frame, 0, 0, cw, ch);
  // slit overlay
  const x = r.slit.posNorm * cw;
  ctx.globalAlpha = 0.16; ctx.fillStyle = "#7e978d";
  const bw = Math.max(2, (r.slit.widthPx * cw) / rw);
  ctx.fillRect(x - bw / 2, 0, bw, ch);
  ctx.globalAlpha = 0.9; ctx.strokeStyle = "#7e978d"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ch); ctx.stroke();
  ctx.globalAlpha = 1;
}

async function drawThumbs(): Promise<void> {
  for (const src of SOURCES) {
    const cv = document.querySelector<HTMLCanvasElement>(`canvas[data-thumb="${src.id}"]`);
    if (!cv || !src.fsrc) continue;
    const tw = 120, th = 90;
    cv.width = tw; cv.height = th;
    const ctx = cv.getContext("2d")!;
    const frame = await renderRotatedFrame(src.fsrc, src.recipes[0].inFrame, 0);
    const fr = frame.width / frame.height, ar = tw / th;
    let dw = tw, dh = th, dx = 0, dy = 0;
    if (fr > ar) { dw = th * fr; dx = (tw - dw) / 2; } else { dh = tw / fr; dy = (th - dh) / 2; }
    ctx.drawImage(frame, dx, dy, dw, dh);
  }
}

// ---- import ----------------------------------------------------------------
function importVideo(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "video/*";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    setStatus(`decoding ${file.name}…`);
    try {
      const fsrc = await VideoFrameSource.fromFile(file);
      const id = `vid-${Date.now()}`;
      SOURCES.push(sourceFromFrameSource(id, file.name, "video", fsrc));
      activeId = id;
      curFrame = 0;
      render();
    } catch (err) {
      setStatus(`import failed: ${(err as Error).message}`);
    }
  };
  input.click();
}

// ---- neural model prefetch (download + cache to OPFS on first click) -------
async function prefetchModel(engine: string): Promise<void> {
  const neural = await import("./neural");
  if (await neural.isCached(engine)) {
    const kb = Math.round((await neural.cachedSize(engine)) / 1024);
    setStatus(`${engine}: model ready (cached ${kb} KB)`);
    return;
  }
  if (!neural.hasUrl(engine)) {
    setStatus(`${engine}: no download URL — drop ${neural.modelFilename(engine)} in OPFS`);
    return;
  }
  setStatus(`${engine}: downloading model…`);
  try {
    await neural.ensureModelBytes(engine, (p) =>
      setStatus(`${engine}: downloading ${Number.isNaN(p) ? "…" : Math.round(p * 100) + "%"}`));
    const kb = Math.round((await neural.cachedSize(engine)) / 1024);
    setStatus(`${engine}: model cached ✓ (${kb} KB)`);
  } catch (e) {
    setStatus(`${engine}: download failed — ${(e as Error).message}`);
  }
}

// ---- render ----------------------------------------------------------------
async function doRender(): Promise<void> {
  if (busy) return;
  const s = active(), r = activeRecipe();
  busy = true;
  render();
  try {
    if (r.engine === "DIS" || r.engine === "DIS↓") {
      setStatus("loading opencv… (first run)");
      const { ensureCv } = await import("./flow");
      await ensureCv();
    } else if (isNeuralEngine(r.engine)) {
      setStatus("loading neural model… (first run)");
    }
    const out = await buildSlitScan(s, r, (p) => setStatus(`rendering… ${(p * 100).toFixed(0)}%`));
    showResult(out, s.name);
    setStatus("done");
  } catch (err) {
    setStatus((err as Error).message);
  } finally {
    busy = false;
    document.querySelector<HTMLButtonElement>('[data-act="render"]')?.removeAttribute("disabled");
  }
}

function showResult(canvas: HTMLCanvasElement, name: string): void {
  document.getElementById("result-modal")?.remove();
  const modal = document.createElement("div");
  modal.id = "result-modal";
  modal.className = "modal";
  modal.innerHTML = `
    <div class="modal-bar">
      <span>[ result ] ${name} · ${canvas.width}×${canvas.height}</span>
      <span class="spacer"></span>
      <button data-act="dl">download png</button>
      <button data-act="close">close</button>
    </div>
    <div class="modal-body"></div>`;
  modal.querySelector(".modal-body")!.appendChild(canvas);
  document.body.appendChild(modal);
  modal.querySelector('[data-act="close"]')!.addEventListener("click", () => modal.remove());
  modal.querySelector('[data-act="dl"]')!.addEventListener("click", () => {
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `slitscan_${Date.now()}.png`;
      a.click();
    }, "image/png");
  });
}

// ---- interp debug review ---------------------------------------------------
async function doDebugInterp(): Promise<void> {
  if (busy) return;
  const s = active(), r = activeRecipe();
  busy = true; render();
  try {
    if (r.engine === "DIS" || r.engine === "DIS↓") {
      setStatus("loading opencv…");
      const { ensureCv } = await import("./flow");
      await ensureCv();
    } else if (isNeuralEngine(r.engine)) {
      setStatus("loading model…");
    }
    setStatus("interpolating debug frames…");
    const seq = await interpolateSequence(s, r, curFrame, 12);
    showInterpDebug(seq);
    setStatus("debug ready");
  } catch (e) {
    setStatus((e as Error).message);
  } finally {
    busy = false;
    document.querySelector('[data-act="debug"]')?.removeAttribute("disabled");
    document.querySelector('[data-act="render"]')?.removeAttribute("disabled");
  }
}

function showInterpDebug(seq: InterpSequence): void {
  document.getElementById("interp-modal")?.remove();
  if (interpTimer !== null) { clearInterval(interpTimer); interpTimer = null; }

  const modal = document.createElement("div");
  modal.id = "interp-modal";
  modal.className = "modal";
  modal.innerHTML = `
    <div class="modal-bar">
      <span>[ interp debug ] frame ${seq.a}→${seq.b} · ${seq.engine} · ${seq.frames.length} steps</span>
      <span class="spacer"></span>
      <button data-d="play">⏸ pause</button>
      <button data-d="close">close</button>
    </div>
    <div class="modal-body"><canvas id="interp-cv"></canvas></div>
    <div class="interp-ctl">
      <input type="range" id="interp-scrub" min="0" max="${seq.frames.length - 1}" value="0" />
      <span class="interp-t" id="interp-t">t=0.00</span>
    </div>`;
  document.body.appendChild(modal);

  const cv = modal.querySelector("#interp-cv") as HTMLCanvasElement;
  cv.width = seq.frames[0].width; cv.height = seq.frames[0].height;
  const ctx = cv.getContext("2d")!;
  let idx = 0;
  let playing = true;

  const draw = () => {
    ctx.putImageData(seq.frames[idx], 0, 0);
    const tl = modal.querySelector("#interp-t");
    if (tl) tl.textContent = `t=${seq.ts[idx].toFixed(2)}` + (idx === 0 ? " (A)" : idx === seq.frames.length - 1 ? " (B)" : "");
    const sc = modal.querySelector("#interp-scrub") as HTMLInputElement | null;
    if (sc) sc.value = String(idx);
  };
  const stop = () => { if (interpTimer !== null) { clearInterval(interpTimer); interpTimer = null; } };
  const start = () => { if (interpTimer === null) interpTimer = window.setInterval(() => { idx = (idx + 1) % seq.frames.length; draw(); }, 120); };

  draw(); start();
  modal.querySelector('[data-d="play"]')!.addEventListener("click", (e) => {
    playing = !playing;
    (e.target as HTMLElement).textContent = playing ? "⏸ pause" : "▶ play";
    if (playing) start(); else stop();
  });
  modal.querySelector("#interp-scrub")!.addEventListener("input", (e) => {
    stop(); playing = false;
    const pb = modal.querySelector('[data-d="play"]'); if (pb) pb.textContent = "▶ play";
    idx = +(e.target as HTMLInputElement).value; draw();
  });
  modal.querySelector('[data-d="close"]')!.addEventListener("click", () => { stop(); modal.remove(); });
}

// ---- keyboard --------------------------------------------------------------
document.addEventListener("keydown", (e) => {
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    const i = SOURCES.findIndex((s) => s.id === activeId);
    const next = e.key === "ArrowDown" ? Math.min(SOURCES.length - 1, i + 1) : Math.max(0, i - 1);
    activeId = SOURCES[next].id;
    curFrame = activeRecipe().inFrame;
    render();
    e.preventDefault();
  }
});

render();

// auto-load served sample footage (host/public/sample.mp4) if present
(async () => {
  try {
    const fsrc = await VideoFrameSource.fromUrl("/sample.mp4");
    SOURCES.push(sourceFromFrameSource("sample", "sample_4k60.mp4", "video", fsrc));
    render();
  } catch { /* no sample available */ }
})();
