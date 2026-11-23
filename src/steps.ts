// 비행별 단계 상태: ① 드론 병합 → ② 고글(맞춤·병합) → ③ HUD. 화면의 단계 줄·카드·일괄 처리가 이것만 본다.
import type { Flight } from "./library.ts";
import type { FlightPrefs } from "./store.ts";

export type DroneStep = "todo" | "done" | "na";
export type GogglesStep = "none" | "sync" | "merge" | "linked" | "done";
export type HudStep = "off" | "blocked" | "todo" | "done";
export interface Steps {
  drone: DroneStep;
  goggles: GogglesStep;
  hud: HudStep;
}
// linked = 연결된 고글 파일명 (offset 순), candidates = 아직 맞추지 않은 겹치는 고글 녹화 수
export interface GogglesFacts {
  linked: string[];
  candidates: number;
  mergedSources?: string[]; // 고글 병합본을 만들 때 쓴 파일들
}

export function stepsOf(f: Flight, g: GogglesFacts, p: FlightPrefs): Steps {
  const drone: DroneStep = f.status === "pending" ? "todo" : f.clips.length > 1 ? "done" : "na";
  const merged = g.mergedSources?.join() === g.linked.join();
  const goggles: GogglesStep =
    f.missing ? "none"
    : g.candidates > 0 ? "sync"
    : g.linked.length === 0 ? "none"
    : g.linked.length === 1 || drone === "todo" ? "linked"
    : merged ? "done"
    : "merge";
  const wants = p.instruments || p.map || (p.goggles && g.linked.length > 0);
  const hud: HudStep = f.overlay ? "done" : !wants || f.missing ? "off" : drone === "todo" || f.analyzing ? "blocked" : "todo";
  return { drone, goggles, hud };
}

export function stepTodo(list: { f: Flight; s: Steps }[]) {
  const sorted = [...list].sort((a, b) => a.f.start - b.f.start);
  return {
    drone: sorted.filter((x) => x.s.drone === "todo" && !x.f.orphan).map((x) => x.f),
    orphans: sorted.filter((x) => x.f.orphan).length,
    goggles: sorted.filter((x) => x.s.goggles === "sync" || x.s.goggles === "merge").map((x) => x.f),
    hud: sorted.filter((x) => x.s.hud === "todo").map((x) => x.f),
    hudBlocked: sorted.filter((x) => x.s.hud === "blocked").length,
  };
}

// 사이드바 "대기": 어느 단계든 할 일이 남음
export const isPendingView = (s: Steps) => s.drone === "todo" || s.goggles === "sync" || s.goggles === "merge" || s.hud === "todo";
