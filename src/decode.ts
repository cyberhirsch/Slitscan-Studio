import { FrameSource } from "./types";

// ---------------------------------------------------------------------------
// VideoFrameSource — decode via <video> + seek/draw. No demuxer needed; works
// for any format the browser plays. Frame access is by seeking to a frame's
// mid-time. (WebCodecs + mp4box is the future precision/speed upgrade.)
// ---------------------------------------------------------------------------
export class VideoFrameSource implements FrameSource {
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  readonly fps: number;
  private readonly video: HTMLVideoElement;
  private readonly duration: number;

  private constructor(video: HTMLVideoElement, fps: number) {
    this.video = video;
    this.width = video.videoWidth;
    this.height = video.videoHeight;
    this.duration = video.duration;
    this.fps = fps;
    this.frameCount = Math.max(1, Math.round(this.duration * fps));
  }

  static async fromFile(file: File): Promise<VideoFrameSource> {
    return VideoFrameSource.fromSrc(URL.createObjectURL(file));
  }

  static async fromUrl(url: string): Promise<VideoFrameSource> {
    return VideoFrameSource.fromSrc(url);
  }

  private static async fromSrc(src: string): Promise<VideoFrameSource> {
    const video = document.createElement("video");
    video.src = src;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("cannot load video"));
    });
    const fps = await detectFps(video).catch(() => 30);
    return new VideoFrameSource(video, fps);
  }

  async drawFrame(index: number, ctx: CanvasRenderingContext2D, w: number, h: number): Promise<void> {
    await this.seek(index);
    ctx.drawImage(this.video, 0, 0, w, h);
  }

  private seek(index: number): Promise<void> {
    const time = Math.min(this.duration - 1e-3, Math.max(0, (index + 0.5) / this.fps));
    return new Promise<void>((resolve) => {
      if (Math.abs(this.video.currentTime - time) < 1e-4 && this.video.readyState >= 2) {
        resolve();
        return;
      }
      const onSeeked = () => {
        this.video.removeEventListener("seeked", onSeeked);
        resolve();
      };
      this.video.addEventListener("seeked", onSeeked);
      this.video.currentTime = time;
    });
  }
}

/** Estimate fps by sampling requestVideoFrameCallback mediaTimes; fallback 30. */
function detectFps(video: HTMLVideoElement): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const anyV = video as unknown as {
      requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
    };
    if (!anyV.requestVideoFrameCallback) {
      reject(new Error("no rVFC"));
      return;
    }
    const times: number[] = [];
    const finish = () => {
      video.pause();
      const deltas = times.slice(1).map((t, i) => t - times[i]).filter((d) => d > 1e-4).sort((a, b) => a - b);
      const med = deltas[Math.floor(deltas.length / 2)];
      resolve(med && med > 0 ? Math.round(1 / med) : 30);
    };
    const cb = (_now: number, meta: { mediaTime: number }) => {
      times.push(meta.mediaTime);
      if (times.length < 8) anyV.requestVideoFrameCallback!(cb);
      else finish();
    };
    anyV.requestVideoFrameCallback!(cb);
    video.play().catch(() => reject(new Error("autoplay blocked")));
    setTimeout(() => (times.length > 1 ? finish() : reject(new Error("timeout"))), 1500);
  });
}
