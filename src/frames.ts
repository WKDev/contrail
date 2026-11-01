// WebCodecs 로 영상 구간을 순차 디코드해 작은 회색 프레임을 일정 간격으로 뽑는다.
// <video> seek 보다 수십 배 빠름 (LRF 프록시 기준 실시간의 수십 배).
import { parse, type Reader, type Track } from "./mp4.ts";
import { videoCodecOf } from "./render.ts";

export const SIG_W = 64;
export const SIG_H = 36;

export interface FrameSamples {
  t: number[]; // 파일 기준 시간 (초)
  frames: Uint8Array[]; // SIG_W x SIG_H 회색
}

export const fileReader = (f: Blob): Reader => ({
  size: f.size,
  read: async (o, l) => new Uint8Array(await f.slice(o, o + l).arrayBuffer()),
});

function sampleIndexAt(tr: Track, sec: number) {
  let dts = 0;
  const target = sec * tr.timescale;
  for (let i = 0; i < tr.count; i++) {
    if (dts + tr.deltas[i] > target) return i;
    dts += tr.deltas[i];
  }
  return tr.count - 1;
}

// crop: 세로 방향으로 위/아래를 잘라낼 비율 (고글 OSD 영역 배제)
export async function sampleFrames(
  file: Blob,
  from: number,
  to: number,
  fps: number,
  opts: { crop?: number; signal?: AbortSignal; track?: Track } = {},
): Promise<FrameSamples> {
  const r = fileReader(file);
  const tr = opts.track ?? (await parse(r));
  const { codec, description } = videoCodecOf(tr);
  const crop = opts.crop ?? 0;
  const syncSet = tr.sync ? new Set(tr.sync) : null;

  // 시작 지점 앞의 키프레임부터 디코드
  let start = sampleIndexAt(tr, Math.max(0, from));
  if (syncSet) while (start > 0 && !syncSet.has(start + 1)) start--;
  const end = sampleIndexAt(tr, to);
  let dts = 0;
  for (let i = 0; i < start; i++) dts += tr.deltas[i];

  const canvas = new OffscreenCanvas(SIG_W, SIG_H);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const out: FrameSamples = { t: [], frames: [] };
  let next = from;
  let error: unknown = null;
  const decoder = new VideoDecoder({
    output: (frame) => {
      const ts = frame.timestamp / 1e6;
      if (ts + 1e-6 >= next && ts <= to + 1e-6) {
        const sh = frame.displayHeight * (1 - 2 * crop);
        ctx.drawImage(frame, 0, frame.displayHeight * crop, frame.displayWidth, sh, 0, 0, SIG_W, SIG_H);
        const d = ctx.getImageData(0, 0, SIG_W, SIG_H).data;
        const g = new Uint8Array(SIG_W * SIG_H);
        for (let i = 0; i < g.length; i++) g[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
        out.t.push(ts);
        out.frames.push(g);
        while (next <= ts + 1e-6) next += 1 / fps;
      }
      frame.close();
    },
    error: (e) => (error = e),
  });
  decoder.configure({ codec, description, codedWidth: tr.width, codedHeight: tr.height });

  const WINDOW = 16 * 1024 * 1024;
  let winStart = 0;
  let win: Uint8Array = new Uint8Array();
  for (let i = start; i <= end; i++) {
    if (error) throw error;
    if (opts.signal?.aborted) throw new DOMException("중단됨", "AbortError");
    while (decoder.decodeQueueSize > 16) await new Promise((r) => setTimeout(r, 1));
    const off = tr.offsets[i];
    const size = tr.sizes[i];
    if (off < winStart || off + size > winStart + win.length) {
      winStart = off;
      win = await r.read(off, Math.min(Math.max(WINDOW, size), r.size - off));
    }
    decoder.decode(
      new EncodedVideoChunk({
        type: !syncSet || syncSet.has(i + 1) ? "key" : "delta",
        timestamp: Math.round(((dts + (tr.cts?.[i] ?? 0)) / tr.timescale) * 1e6),
        data: win.subarray(off - winStart, off - winStart + size),
      }),
    );
    dts += tr.deltas[i];
  }
  await decoder.flush();
  decoder.close();
  if (error) throw error;
  return out;
}

// 한 장의 컬러 썸네일 (이음매 확인용): 파일 내 시간 sec 에 가장 가까운 프레임
export async function frameImage(file: Blob, sec: number, w = 320): Promise<string> {
  const r = fileReader(file);
  const tr = await parse(r);
  const dur = tr.duration;
  const at = Math.min(Math.max(0, sec), Math.max(0, dur - 1 / 60));
  const { codec, description } = videoCodecOf(tr);
  const syncSet = tr.sync ? new Set(tr.sync) : null;
  let idx = sampleIndexAt(tr, at);
  let start = idx;
  if (syncSet) while (start > 0 && !syncSet.has(start + 1)) start--;
  let dts = 0;
  for (let i = 0; i < start; i++) dts += tr.deltas[i];
  const h = Math.round((w * tr.height) / tr.width);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  let best = -1;
  const decoder = new VideoDecoder({
    output: (frame) => {
      const ts = frame.timestamp / 1e6;
      if (ts <= at + 1e-3 && ts > best) {
        ctx.drawImage(frame, 0, 0, w, h);
        best = ts;
      }
      frame.close();
    },
    error: () => {},
  });
  decoder.configure({ codec, description, codedWidth: tr.width, codedHeight: tr.height });
  for (let i = start; i <= idx; i++) {
    const data = await r.read(tr.offsets[i], tr.sizes[i]);
    decoder.decode(new EncodedVideoChunk({ type: !syncSet || syncSet.has(i + 1) ? "key" : "delta", timestamp: Math.round((dts / tr.timescale) * 1e6), data }));
    dts += tr.deltas[i];
  }
  await decoder.flush();
  decoder.close();
  return URL.createObjectURL(await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 }));
}

// 영상 전체에 고르게 퍼진 키프레임 n 장을 w×h RGBA 로 (키프레임만 디코드하므로 빠름)
// onFrame 을 주면 프레임을 모아 두지 않고 한 장씩 넘김 (큰 해상도에서 메모리 절약)
export async function keyframePixels(file: Blob, n: number, w: number, h: number, signal?: AbortSignal, onFrame?: (f: ImageData) => void): Promise<ImageData[]> {
  const r = fileReader(file);
  const tr = await parse(r);
  const { codec, description } = videoCodecOf(tr);
  const keys = tr.sync ? tr.sync.map((s) => s - 1) : Array.from({ length: tr.count }, (_, i) => i);
  // 앞뒤 3% 는 메뉴·시작 화면일 수 있어 뺌
  const lo = Math.floor(keys.length * 0.03), hi = Math.max(lo + 1, Math.ceil(keys.length * 0.97));
  const pick = [...new Set(Array.from({ length: n }, (_, k) => keys[Math.min(hi - 1, lo + Math.floor(((hi - lo) * (k + 0.5)) / n))]))];
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const out: ImageData[] = [];
  for (const i of pick) {
    if (signal?.aborted) throw new DOMException("중단됨", "AbortError");
    const dec = new VideoDecoder({
      output: (f) => {
        ctx.drawImage(f, 0, 0, w, h);
        f.close();
        const img = ctx.getImageData(0, 0, w, h);
        if (onFrame) onFrame(img);
        else out.push(img);
      },
      error: () => {},
    });
    dec.configure({ codec, description, codedWidth: tr.width, codedHeight: tr.height });
    dec.decode(new EncodedVideoChunk({ type: "key", timestamp: 0, data: await r.read(tr.offsets[i], tr.sizes[i]) }));
    await dec.flush();
    dec.close();
  }
  return out;
}
