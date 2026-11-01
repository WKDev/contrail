// 고글 녹화 파일을 비행에 매칭하고 시간 오프셋을 자동으로 찾는다.
import { parse } from "./mp4.ts";
import { fileReader, sampleFrames } from "./frames.ts";
import { bestLag, combineCurves, contentCurve, motionSignal, overlapSeconds, refineLag, type Signal } from "./sync.ts";
import { SIG_H, SIG_W } from "./frames.ts";

export interface FlightClipRef {
  file: Blob; // 프록시(LRF) 우선, 없으면 MP4
  start: number; // epoch ms
  duration: number; // 초
}

export interface GogglesInfo {
  name: string;
  file: File;
  start: number; // epoch ms (추정)
  duration: number;
  width: number;
  height: number;
  timeSource: "metadata" | "modified";
  linked?: boolean; // 고글 폴더에서 바로 읽음 (복사본 아님)
}

export const GOGGLES_RE = /\.(mp4|mov)$/i;
// 폴더 맨 위에 그냥 넣어 둔 고글 녹화도 인식 (드론 원본·앱 결과물 이름은 제외)
export const isRootGoggles = (name: string) => GOGGLES_RE.test(name) && !/^DJI_\d{14}_\d{4}_D\./i.test(name) && !/_(merged|hud|goggles)\.mp4$/i.test(name);

export async function inspectGoggles(file: File): Promise<GogglesInfo> {
  const tr = await parse(fileReader(file));
  const byMeta = tr.creationTime && tr.creationTime > Date.UTC(2015, 0, 1) && tr.creationTime < Date.now() + 86400000;
  return {
    name: file.name,
    file,
    start: byMeta ? tr.creationTime! : file.lastModified - tr.duration * 1000,
    duration: tr.duration,
    width: tr.width,
    height: tr.height,
    timeSource: byMeta ? "metadata" : "modified",
  };
}

// 비행 구간과 실제로 가장 많이 겹치는 고글 파일. 겹치는 게 없으면 시계 차이(60초 이내)를 감안해 시작 시각이 가장 가까운 것.
export function matchGoggles(flight: { start: number; end: number }, list: GogglesInfo[]) {
  let best: GogglesInfo | null = null;
  let bestOv = 0;
  for (const g of list) {
    const ov = overlapSeconds(flight, { start: g.start, end: g.start + g.duration * 1000 });
    if (ov > bestOv) {
      bestOv = ov;
      best = g;
    }
  }
  if (best) return best;
  let bestD = Infinity;
  for (const g of list) {
    const d = Math.abs(g.start - flight.start) / 1000;
    if (d <= 60 && overlapSeconds(flight, { start: g.start, end: g.start + g.duration * 1000 }, 60) > 0 && d < bestD) {
      bestD = d;
      best = g;
    }
  }
  return best;
}

// 클립마다 시각이 겹치는 고글 파일 (고글은 드론 녹화 버튼에 맞춰 켜지고, 7:40 에서 나뉘지 않음)
export function matchGogglesForClips(clips: { start: number; duration: number }[], list: GogglesInfo[]) {
  const out: GogglesInfo[] = [];
  for (const c of clips) {
    const g = matchGoggles({ start: c.start, end: c.start + c.duration * 1000 }, list);
    if (g && !out.includes(g)) out.push(g);
  }
  return out;
}

export interface SyncResult {
  offset: number; // 비행 시간 = 고글 시간 + offset (초)
  score: number; // 0~1 상관도
  coarse: number;
  curve: { lag: number; score: number }[];
}

const FPS = 10;

// 비행 타임라인 [a, b] 의 프레임: 구간이 걸친 각 클립에서 뽑아 비행 시간으로 환산
async function flightFrames(clips: FlightClipRef[], a: number, b: number, signal?: AbortSignal) {
  const t: number[] = [];
  const frames: Uint8Array[] = [];
  let base = 0;
  for (const c of clips) {
    const s = Math.max(a, base);
    const e = Math.min(b, base + c.duration);
    if (e > s) {
      const r = await sampleFrames(c.file, s - base, e - base, FPS, { crop: 0.15, signal });
      r.t.forEach((x, i) => {
        t.push(x + base);
        frames.push(r.frames[i]);
      });
    }
    base += c.duration;
  }
  return { t, frames };
}

export async function syncGoggles(
  clips: FlightClipRef[],
  g: GogglesInfo,
  opts: { search?: number; window?: number; signal?: AbortSignal; onStage?: (s: string) => void } = {},
): Promise<SyncResult> {
  const total = clips.reduce((x, c) => x + c.duration, 0);
  const coarse = (g.start - clips[0].start) / 1000; // 고글 0초 = 비행 coarse 초
  const search = opts.search ?? 20;
  const win = opts.window ?? 90;
  // 겹치는 구간의 가운데 win 초를 비교
  const ovStart = Math.max(0, coarse);
  const ovEnd = Math.min(total, coarse + g.duration);
  const mid = ovEnd > ovStart ? (ovStart + ovEnd) / 2 : Math.min(total, g.duration) / 2;
  const a = Math.max(0, mid - win / 2);
  const b = Math.min(total, mid + win / 2);

  opts.onStage?.("flight");
  const ff = await flightFrames(clips, a, b, opts.signal);
  opts.onStage?.("goggles");
  const ga = Math.max(0, a - coarse - search);
  const gb = Math.min(g.duration, b - coarse + search);
  const gf = await sampleFrames(g.file, ga, gb, FPS, { crop: 0.15, signal: opts.signal });
  const fs: Signal = motionSignal(ff.t, ff.frames, 1 / FPS);
  const gs: Signal = motionSignal(gf.t, gf.frames, 1 / FPS);
  const motion = bestLag(fs, gs, coarse - search, coarse + search);
  const content = contentCurve(ff, gf, coarse - search, coarse + search, 1 / FPS, SIG_W, SIG_H);
  const r = combineCurves(motion.curve, content);
  return { offset: refineLag(r.curve, r.lag), score: Math.max(0, r.score), coarse, curve: r.curve };
}
