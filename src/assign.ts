// 공용 고글: 고글 녹화의 주인 기체 정하기 + 기체별 시계 오차 (순수 함수 — Node 테스트 가능)
//
// 고글 하나로는 한 번에 한 기체만 날린다 → 고글 녹화 하나는 기체 하나에만 속한다.
// 그 기체 안에서는 여러 비행에 시간대별로 연결될 수 있다 (장면 점수로 나뉜 비행).

export interface Owner {
  aircraft?: string;
  by: "linked" | "manual" | "time" | "ambiguous" | "none";
  candidates: string[]; // 시간이 겹치는 기체들 (겹침 큰 순)
}

const AMBIGUOUS = 0.8; // 2등 겹침이 1등의 80% 이상이면 시간만으로 못 정함
const MIN_SCORE = 0.6; // 이 점수 이상인 맞춤에서만 시계 오차를 배움
const MIN_ERR = 3; // 이보다 작은 오차는 무시 (Avata 2 실측 ≈ 0.6초)

const overlapSec = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)) / 1000;

export function ownerOfGoggles(
  goggles: { name: string; start: number; duration: number }[],
  flights: { id: string; aircraft: string; start: number; end: number; day: string }[],
  links: Record<string, { file: string }[]>,
  clockErr: (aircraft: string, day: string) => number,
  manual: Record<string, string>,
): Map<string, Owner> {
  const flightAircraft = new Map(flights.map((f) => [f.id, f.aircraft]));
  const linkedTo = new Map<string, string>();
  for (const [fid, ls] of Object.entries(links)) {
    const a = flightAircraft.get(fid);
    if (a) for (const l of ls) if (!linkedTo.has(l.file)) linkedTo.set(l.file, a);
  }
  const out = new Map<string, Owner>();
  for (const g of goggles) {
    // 기체별 시간 겹침 합 (그 기체·그 날 시계 오차로 고글 시각을 보정)
    const per = new Map<string, number>();
    for (const f of flights) {
      const s = g.start + clockErr(f.aircraft, f.day) * 1000;
      const ov = overlapSec(s, s + g.duration * 1000, f.start, f.end);
      if (ov > 0) per.set(f.aircraft, (per.get(f.aircraft) ?? 0) + ov);
    }
    const ranked = [...per.entries()].sort((a, b) => b[1] - a[1]);
    const candidates = ranked.map(([a]) => a);
    if (manual[g.name]) out.set(g.name, { aircraft: manual[g.name], by: "manual", candidates });
    else if (linkedTo.has(g.name)) out.set(g.name, { aircraft: linkedTo.get(g.name), by: "linked", candidates });
    else if (!ranked.length) out.set(g.name, { by: "none", candidates });
    else if (ranked.length > 1 && ranked[1][1] >= ranked[0][1] * AMBIGUOUS) out.set(g.name, { by: "ambiguous", candidates });
    else out.set(g.name, { aircraft: ranked[0][0], by: "time", candidates });
  }
  return out;
}

// coarse = 시계로 짐작한 위치, offset = 실제로 맞춘 위치 (둘 다 "고글 0초가 비행 몇 초인지").
// 차이 = 고글 시각에 더할 시계 오차 (초). 점수가 낮거나 차이가 작으면 배우지 않음
export function learnClockErr(coarse: number, offset: number, score: number): number | null {
  if (score < MIN_SCORE) return null;
  const err = offset - coarse;
  return Math.abs(err) < MIN_ERR ? null : Math.round(err * 1000) / 1000;
}

export function medianErr(list: number[]): number {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// 한 번의 맞춤에서 얻는 시계 오차 표본: 보정 전 원래 고글 시각 기준 (보정된 시각을 쓰면 오차가 쌓임)
export function clockSample(gogglesStartOrig: number, flightStart: number, offset: number, score: number): number | null {
  return learnClockErr((gogglesStartOrig - flightStart) / 1000, offset, score);
}

// 주인 판정용: 그 기체 비행 중 고글 녹화(원래 시각 + 그 기체 오차)와 가장 많이 겹치는 비행
export function bestFlightFor<F extends { start: number; end: number }>(g: { start: number; duration: number }, flights: F[], errSec: number): F | null {
  const s = g.start + errSec * 1000;
  let best: F | null = null, bestOv = 0;
  for (const f of flights) {
    const ov = overlapSec(s, s + g.duration * 1000, f.start, f.end);
    if (ov > bestOv) (best = f), (bestOv = ov);
  }
  return best;
}

export const shiftGoggles = <T extends { start: number }>(g: T, errSec: number): T => ({ ...g, start: g.start + errSec * 1000 });
