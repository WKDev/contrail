// 병합/제외 자동 선별 규칙 (순수 함수)

export interface Clip {
  name: string; // DJI_..._D.MP4
  stem: string; // DJI_..._D
  start: number; // epoch ms (파일명 기준, 로컬 시각)
  duration: number; // 초
  size: number;
}

export interface Settings {
  minDuration: number; // 이보다 짧으면 제외
  maxGap: number; // 직전 영상 종료~시작 간격(초) 이하일 때만 병합 후보
  simMax: number; // 연속성 점수 이하이면 같은 장면으로 판단
  autoSplitMin: number; // 직전 영상 길이가 이 이상 + 간격 ≤ autoSplitGap 이면 DJI 자동분할
  autoSplitGap: number;
  autoSplitSimMax: number; // 자동분할이라도 이 점수 초과면 병합 안함
}

export const DEFAULT_SETTINGS: Settings = {
  minDuration: 5,
  maxGap: 3,
  simMax: 0.4,
  autoSplitMin: 455,
  autoSplitGap: 1.5,
  autoSplitSimMax: 1.2, // 7:40 자동분할은 거의 확실 — 화면 비교 점수로 막지 않음 (브라우저 점수는 잡음이 큼)
};

export interface Override {
  excluded?: boolean;
  mergePrev?: boolean;
}

export interface Decision {
  excluded: boolean;
  excludeReason: string;
  mergePrev: boolean;
  mergeReason: string;
  gap: number | null; // 직전 영상 종료 → 이 영상 시작 (초)
  candidate: boolean; // 연속성 분석 대상 여부
  score?: number;
  overridden: boolean;
}

export const pairKey = (a: Clip, b: Clip) => `${a.stem}>${b.stem}`;

export function parseStart(name: string): number | null {
  const m = /^DJI_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_/.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

export function sortClips(clips: Clip[]) {
  return [...clips].sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
}

export function decide(
  clips: Clip[],
  scores: Record<string, number>,
  overrides: Record<string, Override>,
  s: Settings,
): Decision[] {
  const out: Decision[] = [];
  clips.forEach((c, i) => {
    const prev = clips[i - 1];
    const gap = prev ? (c.start - prev.start) / 1000 - prev.duration : null;
    const score = prev ? scores[pairKey(prev, c)] : undefined;
    const ov = overrides[c.name] ?? {};

    let excluded = c.duration < s.minDuration;
    let excludeReason = excluded ? `${c.duration.toFixed(1)}s < ${s.minDuration}s` : "";
    if (ov.excluded !== undefined) {
      excluded = ov.excluded;
      excludeReason = "수동";
    }

    const candidate = gap !== null && gap <= s.maxGap;
    const autoSplit = !!prev && gap !== null && prev.duration >= s.autoSplitMin && Math.abs(gap) <= s.autoSplitGap;
    let mergePrev = false;
    let mergeReason = "";
    if (prev && candidate) {
      if (autoSplit && (score === undefined || score <= s.autoSplitSimMax)) {
        mergePrev = true;
        mergeReason = "DJI 자동분할";
      } else if (score !== undefined && score <= (autoSplit ? s.autoSplitSimMax : s.simMax)) {
        mergePrev = true;
        mergeReason = "연속 장면";
      } else if (score === undefined) {
        mergeReason = "분석 필요";
      } else {
        mergeReason = "다른 장면";
      }
    }
    if (ov.mergePrev !== undefined && prev) {
      mergePrev = ov.mergePrev;
      mergeReason = "수동";
    }
    if (excluded || (prev && out[i - 1].excluded)) mergePrev = false;
    out.push({
      excluded,
      excludeReason,
      mergePrev,
      mergeReason,
      gap,
      candidate,
      score,
      overridden: ov.excluded !== undefined || ov.mergePrev !== undefined,
    });
  });
  return out;
}

export function groupClips(clips: Clip[], ds: Decision[]): Clip[][] {
  const groups: Clip[][] = [];
  clips.forEach((c, i) => {
    if (ds[i].excluded) return;
    if (ds[i].mergePrev && groups.length) groups[groups.length - 1].push(c);
    else groups.push([c]);
  });
  return groups;
}

export function defaultTitle(start: number) {
  const d = new Date(start);
  const p = (n: number) => String(n).padStart(2, "0");
  return `DJI ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
