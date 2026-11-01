// 고글 녹화 ↔ 비행 영상 시간 동기화 (순수 함수 — Node 테스트 가능)
//
// 고글 녹화(DVR)는 드론 카메라 실시간 영상을 그대로 담으므로 두 영상의 "움직임 세기" 신호
// (연속 프레임 간 평균 밝기 차)가 같은 모양을 그린다. 이 신호의 정규화 교차상관이 최대가 되는
// 지연을 찾는다. 해상도·화각·압축 차이에 강하다.

export interface Signal {
  t0: number; // 첫 샘플 시간 (초)
  dt: number; // 샘플 간격 (초)
  v: Float32Array;
}

// 프레임 목록 → 균일 간격 움직임 신호
export function motionSignal(t: number[], frames: Uint8Array[], dt: number): Signal {
  const raw: { t: number; e: number }[] = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    let s = 0;
    for (let k = 0; k < a.length; k++) s += Math.abs(a[k] - b[k]);
    raw.push({ t: (t[i] + t[i - 1]) / 2, e: s / a.length / Math.max(1e-3, t[i] - t[i - 1]) });
  }
  if (!raw.length) return { t0: 0, dt, v: new Float32Array() };
  const t0 = raw[0].t;
  const n = Math.max(1, Math.floor((raw[raw.length - 1].t - t0) / dt) + 1);
  const v = new Float32Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const tt = t0 + i * dt;
    while (j < raw.length - 2 && raw[j + 1].t < tt) j++;
    const a = raw[j];
    const b = raw[Math.min(j + 1, raw.length - 1)];
    const f = b.t === a.t ? 0 : Math.min(1, Math.max(0, (tt - a.t) / (b.t - a.t)));
    v[i] = a.e + (b.e - a.e) * f;
  }
  return { t0, dt, v };
}

// 정규화 교차상관. 반환 lag: flight(t) ≈ goggles(t - lag)  즉 flightTime = gogglesTime + lag
export function bestLag(flight: Signal, goggles: Signal, lagMin: number, lagMax: number) {
  const dt = flight.dt;
  let best = { lag: 0, score: -Infinity, overlap: 0 };
  const curve: { lag: number; score: number }[] = [];
  for (let lag = lagMin; lag <= lagMax + 1e-9; lag += dt) {
    // goggles 샘플 j 의 flight 시간 = goggles.t0 + j*dt + lag
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
    for (let i = 0; i < flight.v.length; i++) {
      const tf = flight.t0 + i * dt;
      const jf = (tf - lag - goggles.t0) / goggles.dt;
      const j = Math.round(jf);
      if (j < 0 || j >= goggles.v.length) continue;
      const a = flight.v[i];
      const b = goggles.v[j];
      sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; n++;
    }
    if (n < 20) continue;
    const cov = sab / n - (sa / n) * (sb / n);
    const va = saa / n - (sa / n) ** 2;
    const vb = sbb / n - (sb / n) ** 2;
    const score = va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
    curve.push({ lag, score });
    if (score > best.score) best = { lag, score, overlap: n * dt };
  }
  return { ...best, curve };
}

// 화면 내용 비교: 각 지연에서 같은 순간으로 맞춘 프레임 쌍의 정규화 상관 평균.
// 움직임이 적은(호버링) 구간에서는 움직임 신호보다 훨씬 확실하다.
export interface Frames {
  t: number[];
  frames: Uint8Array[];
}

function downNorm(g: Uint8Array, w: number, h: number, f: number) {
  const W = Math.floor(w / f), H = Math.floor(h / f);
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) s += g[(y * f + dy) * w + x * f + dx];
      out[y * W + x] = s;
    }
  let m = 0;
  for (const v of out) m += v;
  m /= out.length;
  let sd = 0;
  for (let i = 0; i < out.length; i++) sd += (out[i] -= m) ** 2;
  sd = Math.sqrt(sd / out.length) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= sd;
  return out;
}

export function contentCurve(flight: Frames, goggles: Frames, lagMin: number, lagMax: number, dt: number, w: number, h: number) {
  const F = flight.frames.map((g) => downNorm(g, w, h, 2));
  const G = goggles.frames.map((g) => downNorm(g, w, h, 2));
  const nearest = (ts: number[], t: number) => {
    let lo = 0, hi = ts.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (ts[m] <= t) lo = m;
      else hi = m;
    }
    return Math.abs(ts[lo] - t) <= Math.abs(ts[hi] - t) ? lo : hi;
  };
  const curve: { lag: number; score: number }[] = [];
  // 비행 프레임을 0.5초 간격으로만 써서 계산량 제한
  const step = Math.max(1, Math.round(0.5 / Math.max(1e-3, flight.t[1] - flight.t[0] || dt)));
  for (let lag = lagMin; lag <= lagMax + 1e-9; lag += dt) {
    let sum = 0, n = 0;
    for (let i = 0; i < F.length; i += step) {
      const tg = flight.t[i] - lag;
      if (tg < goggles.t[0] - dt || tg > goggles.t[goggles.t.length - 1] + dt) continue;
      const a = F[i], b = G[nearest(goggles.t, tg)];
      let c = 0;
      for (let k = 0; k < a.length; k++) c += a[k] * b[k];
      sum += c / a.length;
      n++;
    }
    if (n >= 6) curve.push({ lag, score: sum / n });
  }
  return curve;
}

// 두 곡선(움직임, 내용)을 합쳐 최종 지연 결정
export function combineCurves(a: { lag: number; score: number }[], b: { lag: number; score: number }[]) {
  const m = new Map(b.map((x) => [x.lag.toFixed(3), x.score]));
  const out = a.filter((x) => m.has(x.lag.toFixed(3))).map((x) => ({ lag: x.lag, score: (x.score + m.get(x.lag.toFixed(3))!) / 2 }));
  let best = out[0] ?? { lag: 0, score: 0 };
  for (const x of out) if (x.score > best.score) best = x;
  return { ...best, curve: out };
}

// 서브샘플 정밀화: 최고점 주변 포물선 보간
export function refineLag(curve: { lag: number; score: number }[], lag: number) {
  const i = curve.findIndex((c) => Math.abs(c.lag - lag) < 1e-6);
  if (i <= 0 || i >= curve.length - 1) return lag;
  const [a, b, c] = [curve[i - 1].score, curve[i].score, curve[i + 1].score];
  const den = a - 2 * b + c;
  if (den >= 0) return lag;
  const step = curve[i + 1].lag - curve[i].lag;
  return lag + (0.5 * (a - c) / den) * step;
}

export interface Interval {
  start: number; // epoch ms
  end: number;
}

// 고글 파일(시작/끝 시각) 중 비행 구간과 가장 많이 겹치는 것 (여유 slack 초)
export function overlapSeconds(a: Interval, b: Interval, slackSec = 0) {
  const s = Math.max(a.start, b.start - slackSec * 1000);
  const e = Math.min(a.end, b.end + slackSec * 1000);
  return Math.max(0, (e - s) / 1000);
}

export const confidenceLabel = (score: number) => (score >= 0.6 ? "high" : score >= 0.35 ? "medium" : "low");
