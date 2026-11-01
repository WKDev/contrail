// 배치 편집 스냅: 화면 기준선·다른 위젯 가장자리/가운데·일정 간격·원끼리 맞닿기·같은 크기.
// 입력/출력 상자는 화면 비율(0~1), 계산은 픽셀(W×H)에서 한다 — 원형 위젯은 픽셀상 원이므로.
import type { Box } from "./store.ts";

export interface SnapBox extends Box {
  round?: boolean;
}
export interface Snap {
  box: Box;
  gx: number[]; // 세로 기준선 (x, 0~1)
  gy: number[]; // 가로 기준선 (y, 0~1)
  hits: number[]; // 맞춰진 다른 상자 (others 의 인덱스)
  same?: number; // 같은 크기로 맞춘 상자
  touch?: number; // 원끼리 맞닿은 상자
}
export type Corner = "nw" | "ne" | "sw" | "se";

export const GAP = 0.012; // 위젯 사이 기본 간격 (화면 너비 비율, 1920 기준 ≈ 23px)
const ASPECT_MIN = 0.02;

type Line = { v: number; other: number };
type Hit = { d: number; line: number; delta: number; other: number };

function nearest(anchors: number[], lines: Line[], tol: number): Hit | null {
  let best: Hit | null = null;
  for (const a of anchors)
    for (const l of lines) {
      const d = Math.abs(a - l.v);
      if (d <= tol && (!best || d < best.d)) best = { d, line: l.v, delta: l.v - a, other: l.other };
    }
  return best;
}

// 픽셀 기준선: 화면 가장자리·가운데·안전 여백, 다른 상자의 양 끝·가운데, 그리고 간격(gap)을 둔 옆자리
function lines(others: SnapBox[], W: number, H: number, axis: "x" | "y") {
  const S = axis === "x" ? W : H;
  const gap = GAP * W;
  const out: Line[] = [0, 0.5, 1, axis === "x" ? 0.02 : 0.035, axis === "x" ? 0.98 : 0.965].map((v) => ({ v: v * S, other: -1 }));
  others.forEach((o, i) => {
    const a = (axis === "x" ? o.x : o.y) * S;
    const len = (axis === "x" ? o.w : o.h) * S;
    out.push({ v: a, other: i }, { v: a + len / 2, other: i }, { v: a + len, other: i }, { v: a - gap, other: i }, { v: a + len + gap, other: i });
  });
  return out;
}

const toPx = (b: Box, W: number, H: number) => ({ x: b.x * W, y: b.y * H, w: b.w * W, h: b.h * H });
const toN = (b: { x: number; y: number; w: number; h: number }, W: number, H: number): Box => ({ x: b.x / W, y: b.y / H, w: b.w / W, h: b.h / H });

// 옮기기
export function snapMove(raw: Box, round: boolean, others: SnapBox[], W: number, H: number, tol: number): Snap {
  const b = toPx(raw, W, H);
  const res: Snap = { box: raw, gx: [], gy: [], hits: [] };

  // 1) 원끼리 맞닿기: 중심 거리 = 반지름 합 (또는 + 간격). 대각선으로 붙여도 원 테두리가 맞닿음
  if (round) {
    const r1 = b.w / 2;
    const c = { x: b.x + r1, y: b.y + b.h / 2 };
    let best: { err: number; i: number; x: number; y: number } | null = null;
    others.forEach((o, i) => {
      if (!o.round) return;
      const p = toPx(o, W, H);
      const r2 = p.w / 2;
      const co = { x: p.x + r2, y: p.y + p.h / 2 };
      const d = Math.hypot(c.x - co.x, c.y - co.y);
      if (d < 1) return;
      for (const target of [r1 + r2, r1 + r2 + GAP * W]) {
        const err = Math.abs(d - target);
        if (err > tol * 1.5 || (best && err >= best.err)) continue;
        let ux = (c.x - co.x) / d, uy = (c.y - co.y) / d;
        // 거의 가로/세로로 나란하면 정확히 나란하게
        if (Math.abs(c.y - co.y) < tol) (ux = Math.sign(ux) || 1), (uy = 0);
        else if (Math.abs(c.x - co.x) < tol) (ux = 0), (uy = Math.sign(uy) || 1);
        best = { err, i, x: co.x + ux * target, y: co.y + uy * target };
      }
    });
    if (best) {
      const { i, x, y } = best as { i: number; x: number; y: number };
      const o = toPx(others[i], W, H);
      res.box = toN({ x: x - r1, y: y - b.h / 2, w: b.w, h: b.h }, W, H);
      res.hits = [i];
      res.touch = i;
      if (Math.abs(y - (o.y + o.h / 2)) < 0.5) res.gy.push((o.y + o.h / 2) / H);
      if (Math.abs(x - (o.x + o.w / 2)) < 0.5) res.gx.push((o.x + o.w / 2) / W);
      return res;
    }
  }

  // 2) 가로·세로 기준선
  const sx = nearest([b.x, b.x + b.w / 2, b.x + b.w], lines(others, W, H, "x"), tol);
  const sy = nearest([b.y, b.y + b.h / 2, b.y + b.h], lines(others, W, H, "y"), tol);
  if (sx) (b.x += sx.delta), res.gx.push(sx.line / W), sx.other >= 0 && res.hits.push(sx.other);
  if (sy) (b.y += sy.delta), res.gy.push(sy.line / H), sy.other >= 0 && res.hits.push(sy.other);
  res.box = toN(b, W, H);
  return res;
}

// 모서리 끌어 크기 조절: 반대쪽 모서리 고정. 원형은 픽셀상 정사각형 유지
export function snapResize(start: Box, corner: Corner, dx: number, dy: number, round: boolean, others: SnapBox[], W: number, H: number, tol: number, snap: boolean): Snap {
  const s = toPx(start, W, H);
  const west = corner === "nw" || corner === "sw";
  const north = corner === "nw" || corner === "ne";
  const min = ASPECT_MIN * W;
  let x1 = s.x, y1 = s.y, x2 = s.x + s.w, y2 = s.y + s.h;
  if (west) x1 = Math.min(x2 - min, s.x + dx * W);
  else x2 = Math.max(x1 + min, x2 + dx * W);
  const res: Snap = { box: start, gx: [], gy: [], hits: [] };

  if (snap) {
    // 가장자리 기준선 vs 같은 너비 중 더 가까운 쪽
    const edge = nearest([west ? x1 : x2], lines(others, W, H, "x"), tol);
    const w = x2 - x1;
    let same: { d: number; w: number; i: number } | null = null;
    others.forEach((o, i) => {
      if (!!o.round !== round) return;
      const ow = o.w * W;
      const d = Math.abs(ow - w);
      if (d <= tol && (!same || d < same.d)) same = { d, w: ow, i };
    });
    const sm = same as { d: number; w: number; i: number } | null;
    if (sm && (!edge || sm.d <= edge.d)) {
      if (west) x1 = x2 - sm.w;
      else x2 = x1 + sm.w;
      res.same = sm.i;
      res.hits.push(sm.i);
    } else if (edge) {
      if (west) x1 += edge.delta;
      else x2 += edge.delta;
      res.gx.push(edge.line / W);
      if (edge.other >= 0) res.hits.push(edge.other);
    }
  }

  if (round) {
    const h = x2 - x1;
    if (north) y1 = y2 - h;
    else y2 = y1 + h;
  } else {
    if (north) y1 = Math.min(y2 - min * 0.5, s.y + dy * H);
    else y2 = Math.max(y1 + min * 0.5, y2 + dy * H);
    if (snap) {
      const edge = nearest([north ? y1 : y2], lines(others, W, H, "y"), tol);
      const h = y2 - y1;
      let same: { d: number; h: number; i: number } | null = null;
      if (res.same === undefined)
        others.forEach((o, i) => {
          if (o.round) return;
          const oh = o.h * H;
          const d = Math.abs(oh - h);
          if (d <= tol && (!same || d < same.d)) same = { d, h: oh, i };
        });
      const sm = same as { d: number; h: number; i: number } | null;
      if (sm && (!edge || sm.d <= edge.d)) {
        if (north) y1 = y2 - sm.h;
        else y2 = y1 + sm.h;
        res.same = sm.i;
        res.hits.push(sm.i);
      } else if (edge) {
        if (north) y1 += edge.delta;
        else y2 += edge.delta;
        res.gy.push(edge.line / H);
        if (edge.other >= 0) res.hits.push(edge.other);
      }
    }
  }
  res.box = toN({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, W, H);
  return res;
}
