// 고글 녹화 한 파일의 성격: 화면 배율(축소/전체) + 고정 OSD 통계. 파일마다 한 번 계산해 캐시
import { keyframePixels } from "./frames.ts";
import { looksInset, StaticAccumulator, type StaticMask } from "./osdkey.ts";

export interface GogglesAnalysis {
  view: "inset" | "full";
  stat: StaticMask;
}
const cache = new Map<string, Promise<GogglesAnalysis>>();
export function analyzeGoggles(file: File): Promise<GogglesAnalysis> {
  const key = `${file.name}:${file.size}:${file.lastModified}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      // 얇은 획 사이 틈까지 보려고 1920×1080 으로 누적 (프레임은 쌓아 두지 않음)
      const acc = new StaticAccumulator(1920, 1080);
      let inset = 0;
      await keyframePixels(file, 24, 1920, 1080, undefined, (f) => {
        acc.add(f);
        if (looksInset(f)) inset++;
      });
      if (!acc.frames) throw new Error("no frames");
      // 메뉴 화면이 섞여도 되도록 다수결
      return { view: inset * 2 > acc.frames ? "inset" : "full", stat: acc.finish() } as GogglesAnalysis;
    })();
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}
