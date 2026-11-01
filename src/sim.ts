// 두 프레임(그레이스케일, 같은 크기)의 "연속성" 점수.
// 각 프레임을 평균 0 / 표준편차 1 로 정규화(노출 변화 무시)한 뒤,
// ±R 픽셀 전역 이동(드론 이동 = 대략 전역 optical flow)을 탐색해 최소 평균절대차를 구한다.
// 0 에 가까울수록 같은 장면, ~1 이상이면 완전히 다른 장면.

export const SIM_W = 96;
export const SIM_H = 54;

function normalize(g: ArrayLike<number>): Float32Array {
  const n = g.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += g[i];
  mean /= n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (g[i] - mean) ** 2;
  const sd = Math.sqrt(v / n) || 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (g[i] - mean) / sd;
  return out;
}

export function continuity(a: ArrayLike<number>, b: ArrayLike<number>, w = SIM_W, h = SIM_H, r = 8) {
  const A = normalize(a);
  const B = normalize(b);
  let best = Infinity;
  let bestDx = 0;
  let bestDy = 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      let sum = 0;
      let cnt = 0;
      for (let y = Math.max(0, -dy); y < Math.min(h, h - dy); y++) {
        const ra = y * w;
        const rb = (y + dy) * w;
        for (let x = Math.max(0, -dx); x < Math.min(w, w - dx); x++) {
          sum += Math.abs(A[ra + x] - B[rb + x + dx]);
          cnt++;
        }
      }
      const mad = sum / cnt;
      if (mad < best) {
        best = mad;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }
  return { score: best, dx: bestDx, dy: bestDy };
}
