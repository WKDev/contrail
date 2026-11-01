// 브라우저 <video> 로 프레임 추출 (LRF 프록시 우선 → 빠름)
import { SIM_H, SIM_W } from "./sim.ts";

function loadVideo(file: File) {
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  const url = URL.createObjectURL(file);
  v.src = url;
  const ready = new Promise<void>((ok, err) => {
    const timer = setTimeout(() => err(new Error(`메타데이터 로드 시간 초과: ${file.name}`)), 20000);
    v.onloadedmetadata = () => (clearTimeout(timer), ok());
    v.onerror = () => (clearTimeout(timer), err(new Error(`재생 불가: ${file.name} (${v.error?.message ?? ""})`)));
  });
  return { v, ready, dispose: () => URL.revokeObjectURL(url) };
}

function seek(v: HTMLVideoElement, t: number) {
  return new Promise<void>((ok, err) => {
    const timer = setTimeout(() => err(new Error("seek timeout")), 15000);
    // seeked 시점에 해당 프레임이 디코드되어 drawImage 가능 (rVFC 는 DOM 밖 video 에서 안 불림)
    v.onseeked = () => (clearTimeout(timer), ok());
    v.currentTime = t;
  });
}

async function grab(file: File, where: "first" | "last", w: number, h: number) {
  const { v, ready, dispose } = loadVideo(file);
  try {
    await ready;
    await seek(v, where === "first" ? 0.001 : Math.max(0, v.duration - 0.1));
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(v, 0, 0, w, h);
    return { ctx, canvas: c };
  } finally {
    v.removeAttribute("src");
    v.load();
    dispose();
  }
}

export async function grayFrame(file: File, where: "first" | "last") {
  const { ctx } = await grab(file, where, SIM_W, SIM_H);
  const d = ctx.getImageData(0, 0, SIM_W, SIM_H).data;
  const g = new Uint8Array(SIM_W * SIM_H);
  for (let i = 0; i < g.length; i++) g[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
  return g;
}

export async function thumbnail(file: File) {
  const { canvas } = await grab(file, "first", 160, 90);
  return URL.createObjectURL(await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 }));
}
