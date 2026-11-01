// 고글 OSD 만 남기는 키. 캔버스 없이 RGBA 픽셀 배열만 다룬다 (테스트 가능).
export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}
const smooth = (v: number, a: number, b: number) => (v <= a ? 0 : v >= b ? 1 : (v - a) / (b - a));

// 축소 화면(카메라 화면 밖 검은 여백 위 OSD): 가장 밝은 채널이 어두우면 투명
export function keyBlack(p: Pixels, stat?: StaticMask & { x0: number; y0: number; W: number; H: number }) {
  const { data: d, width: w } = p;
  for (let i = 0; i < d.length; i += 4) {
    const mx = Math.max(d[i], d[i + 1], d[i + 2]);
    if (mx >= 70) continue;
    if (stat) {
      // 꽉 찬 흰 기호 안의 검은 글자(모드 표시 M 등)는 지우지 않음
      const k = i >> 2, x = k % w, y = (k / w) | 0;
      const sx = Math.min(stat.w - 1, (((stat.x0 + x) / stat.W) * stat.w) | 0), sy = Math.min(stat.h - 1, (((stat.y0 + y) / stat.H) * stat.h) | 0);
      if (stat.data[sy * stat.w + sx] >= 253) continue;
    }
    d[i + 3] = (d[i + 3] * smooth(mx, 22, 70)) | 0;
  }
}

// 전체 화면(100%, 카메라 화면 위 OSD): Goggles 3 OSD = 흰 글자(경고는 빨강·주황) + 얇은 검은 그림자.
// "밝고 무채색(또는 빨강 계열)" 이면서 "몇 px 안에 확 어두운 픽셀(그림자)" 이 있는 곳만 글자로 본다.
// 하늘·구름처럼 밝기만 하고 그림자가 없는 곳은 빠진다. 그림자는 합성할 때 새로 그린다.
// stat: staticMask 결과(작은 해상도) + 이 조각이 출력 프레임(W×H)의 어디(x0,y0)인지
export interface StaticMask {
  data: Uint8Array;
  w: number;
  h: number;
}
// 빨강·주황(경고·배터리·GPS 아이콘)은 오른쪽 아래 인디케이터 줄에서만 인식 (출력 프레임 비율)
export const WARM_ZONE = { x: 0.5, y: 0.78 };
// pos: 이 조각이 출력 프레임(W×H)의 어디(x0,y0)인지. 없으면 위치 제한 없음
export function keyWhite(p: Pixels, frameH: number, stat?: StaticMask & { x0: number; y0: number; W: number; H: number }, pos?: { x0: number; y0: number; W: number; H: number }) {
  const at = pos ?? stat;
  const { data: d, width: w, height: h } = p;
  const n = w * h;
  const Y = new Uint8Array(n);
  for (let k = 0, i = 0; k < n; k++, i += 4) Y[k] = (d[i] * 2 + d[i + 1] * 5 + d[i + 2]) >> 3;
  // 주변 최소 밝기 (가로·세로 분리 최소값 필터): 글자 바로 옆 그림자
  const r = Math.max(2, Math.round(frameH * 0.004));
  const tmp = new Uint8Array(n);
  const mn = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = 255;
      for (let k = Math.max(0, x - r), e = Math.min(w - 1, x + r); k <= e; k++) if (Y[row + k] < m) m = Y[row + k];
      tmp[row + x] = m;
    }
  }
  for (let x = 0; x < w; x++)
    for (let y = 0; y < h; y++) {
      let m = 255;
      for (let k = Math.max(0, y - r), e = Math.min(h - 1, y + r); k <= e; k++) if (tmp[k * w + x] < m) m = tmp[k * w + x];
      mn[y * w + x] = m;
    }
  const a = new Float32Array(n);
  const col = new Float32Array(n); // 색만 보면 OSD 일 수 있는 픽셀
  const rd = new Float32Array(n);
  for (let k = 0, i = 0; k < n; k++, i += 4) {
    const R = d[i], G = d[i + 1], B = d[i + 2];
    const hi = Math.max(R, G, B), lo = Math.min(R, G, B);
    const white = smooth(lo, 165, 210) * (1 - smooth(hi - lo, 35, 70));
    const inWarm = !at || ((at.x0 + (k % w)) / at.W >= WARM_ZONE.x && (at.y0 + ((k / w) | 0)) / at.H >= WARM_ZONE.y);
    if (!inWarm) {
      col[k] = white;
      a[k] = white * smooth(Y[k] - mn[k], 60, 120);
      continue;
    }
    const warm = R >= G && R >= B ? smooth(R, 170, 210) * smooth(R - B, 100, 140) : 0; // 빨강·주황 경고 글자
    // 진한 빨강(충격 감지 같은 경고 띠·배경 상자)은 그림자 없이도 OSD 로 봄. 꽃·노을 같은 분홍·주황은 G/B 가 높아 빠짐
    const red = R >= G && R >= B ? smooth(R, 130, 170) * smooth(R - Math.max(G, B), 75, 115) : 0;
    const edge = smooth(Y[k] - mn[k], 60, 120);
    col[k] = Math.max(white, warm, red);
    a[k] = Math.max(white, warm) * edge;
    rd[k] = red;
  }
  // 여러 장면 통계가 있으면: 255 = 고정 OSD(모드 상자·아이콘·단위) → 색만 맞으면 살림,
  // 128 = OSD 가 가끔 나타나는 자리(숫자) → 획 판정 유지, 0 = OSD 가 나온 적 없는 자리 → 획 판정 무시 (하늘·나뭇가지 오인 방지)
  if (stat) {
    for (let y = 0; y < h; y++) {
      const sy = Math.min(stat.h - 1, (((stat.y0 + y) / stat.H) * stat.h) | 0);
      for (let x = 0; x < w; x++) {
        const sx = Math.min(stat.w - 1, (((stat.x0 + x) / stat.W) * stat.w) | 0);
        const k = y * w + x;
        const z = stat.data[sy * stat.w + sx];
        if (z === 254) a[k] = Math.max(a[k], col[k], 0.9); // 모드 표시 상자 흰 바탕
        else if (z === 253) {
          // 상자 안 글자 자리: 이 프레임에서 흰색이면 상자 바탕(모드가 바뀌어 글자 모양이 달라짐),
          // 아니면 고글이 뚫어 놓아 뒤 화면이 비치는 글자 → 검게
          a[k] = 1;
          if (col[k] < 0.5) d[k * 4] = d[k * 4 + 1] = d[k * 4 + 2] = 18;
        }
        else if (z === 255) a[k] = Math.max(a[k], col[k]);
        else if (z === 0) a[k] = 0;
      }
    }
  }
  // 진한 빨강 경고 상자는 어디서든 (드물게 나와서 통계에 안 잡힘). 상자 안 흰 글자도 같이
  const near = new Float32Array(n);
  {
    const t2 = new Float32Array(n);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let m = 0;
        for (let k = Math.max(0, x - r), e = Math.min(w - 1, x + r); k <= e; k++) if (rd[y * w + k] > m) m = rd[y * w + k];
        t2[y * w + x] = m;
      }
    for (let x = 0; x < w; x++)
      for (let y = 0; y < h; y++) {
        let m = 0;
        for (let k = Math.max(0, y - r), e = Math.min(h - 1, y + r); k <= e; k++) if (t2[k * w + x] > m) m = t2[k * w + x];
        near[y * w + x] = m;
      }
  }
  for (let k = 0; k < n; k++) {
    if (rd[k] > a[k]) a[k] = rd[k];
    const inBox = Math.min(near[k], col[k]);
    if (inBox > a[k]) a[k] = inBox;
  }
  // 글자 가장자리(안티앨리어싱) 1px 살림
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      let m = a[k];
      if (m < 0.5) {
        const nb = Math.max(x > 0 ? a[k - 1] : 0, x < w - 1 ? a[k + 1] : 0, y > 0 ? a[k - w] : 0, y < h - 1 ? a[k + w] : 0);
        if (nb * 0.5 > m) m = nb * 0.5;
      }
      d[k * 4 + 3] = (d[k * 4 + 3] * m) | 0;
    }
}

// 고글 녹화 화면 배율 추정: 축소 화면이면 왼쪽 위 구석이 검다 (카메라 화면은 가운데)
export function looksInset(p: Pixels) {
  const { data: d, width: w, height: h } = p;
  let sum = 0, cnt = 0;
  for (let y = Math.round(h * 0.02); y < h * 0.11; y++)
    for (let x = Math.round(w * 0.02); x < w * 0.11; x++) {
      const i = (y * w + x) * 4;
      sum += Math.max(d[i], d[i + 1], d[i + 2]);
      cnt++;
    }
  return sum / Math.max(1, cnt) < 14;
}

// 같은 고글 녹화의 여러 장면에서: 거의 늘 흰색/빨강·주황 = 고정 OSD(255), 가끔이라도 = OSD 자리(128),
// 늘 흰 꽉 찬 상자 = 모드 표시(254 바탕 / 253 안 글자). 프레임을 쌓아 두지 않고 한 장씩 누적 (원본 해상도로 계산 가능)
export class StaticAccumulator {
  cnt: Uint16Array;
  frames = 0;
  w: number;
  h: number;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.cnt = new Uint16Array(w * h);
  }
  add(f: Pixels) {
    const d = f.data, cnt = this.cnt;
    for (let k = 0, i = 0; k < cnt.length; k++, i += 4) {
      const R = d[i], G = d[i + 1], B = d[i + 2];
      const hi = Math.max(R, G, B), lo = Math.min(R, G, B);
      if ((lo > 175 && hi - lo < 55) || (R > 170 && R >= G && R - B > 100)) cnt[k]++;
    }
    this.frames++;
  }
  finish(ratio = 0.85, zoneRatio = 0.12): StaticMask {
    return finishStatic(this.cnt, this.w, this.h, this.frames, ratio, zoneRatio);
  }
}
export function staticMask(frames: Pixels[], ratio = 0.85, zoneRatio = 0.12): StaticMask {
  const acc = new StaticAccumulator(frames[0].width, frames[0].height);
  for (const f of frames) acc.add(f);
  return acc.finish(ratio, zoneRatio);
}
function finishStatic(cnt: Uint16Array, w: number, h: number, nFrames: number, ratio: number, zoneRatio: number): StaticMask {
  const n = w * h;
  const frames = { length: nFrames };
  const need = Math.ceil(frames.length * ratio);
  const zone = Math.max(1, Math.ceil(frames.length * zoneRatio));
  const out = new Uint8Array(n);
  const rs = 1, rz = Math.max(2, Math.round(h * 0.01));
  const dil = (thr: number, rad: number, val: number) => {
    // 가로·세로 분리 팽창
    const tmp = new Uint8Array(n);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        for (let k = Math.max(0, x - rad), e = Math.min(w - 1, x + rad); k <= e; k++)
          if (cnt[y * w + k] >= thr) {
            tmp[y * w + x] = 1;
            break;
          }
      }
    for (let x = 0; x < w; x++)
      for (let y = 0; y < h; y++) {
        for (let k = Math.max(0, y - rad), e = Math.min(h - 1, y + rad); k <= e; k++)
          if (tmp[k * w + x]) {
            if (out[y * w + x] < val) out[y * w + x] = val;
            break;
          }
      }
  };
  dil(zone, rz, 128);
  dil(need, rs, 255);
  // 꽉 찬 흰 기호(모드 표시 M/S/N 상자 등): 늘 흰 덩어리 중 테두리 상자의 절반 이상이 흰 것 → 안의 검은 글자까지 살림 = 254.
  // 상자는 기울어진 평행사변형이라, 사각형이 아니라 줄마다 덩어리의 왼쪽 끝~오른쪽 끝만 채워 모양을 그대로 따름
  const lab = new Uint8Array(n);
  const st: number[] = [];
  for (let k0 = 0; k0 < n; k0++) {
    if (cnt[k0] < need || lab[k0]) continue;
    let x0 = w, y0 = h, x1 = 0, y1 = 0, area = 0;
    const pix: number[] = [];
    st.push(k0);
    lab[k0] = 1;
    while (st.length) {
      const k = st.pop()!;
      const x = k % w, y = (k / w) | 0;
      pix.push(k);
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (const q of [k - 1, k + 1, k - w, k + w]) {
        if (q < 0 || q >= n || (q === k - 1 && x === 0) || (q === k + 1 && x === w - 1)) continue;
        if (cnt[q] >= need && !lab[q]) (lab[q] = 1), st.push(q);
      }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const big = bw >= h * 0.02 && bh >= h * 0.02 && bw <= h * 0.12 && bh <= h * 0.12;
    if (!big || area < bw * bh * 0.4 || bw / bh > 2.5 || bh / bw > 2.5) continue;
    // 구멍 = 테두리 상자 바깥에서 흰 덩어리를 건너지 않고 닿을 수 없는 곳 (모드 상자 안 글자).
    // H 처럼 틈이 바깥으로 열린 글자는 구멍이 없어 제외. 모양은 덩어리+구멍 그대로라 평행사변형을 따름
    const BW = bw + 2, BH = bh + 2;
    const inBlob = new Uint8Array(BW * BH);
    for (const k of pix) inBlob[((((k / w) | 0) - y0 + 1) * BW) + (k % w) - x0 + 1] = 1;
    const seen = new Uint8Array(BW * BH);
    const q = [0];
    seen[0] = 1;
    while (q.length) {
      const c = q.pop()!;
      const cx = c % BW, cy = (c / BW) | 0;
      for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
        if (nx < 0 || ny < 0 || nx >= BW || ny >= BH) continue;
        const nk = ny * BW + nx;
        if (!seen[nk] && !inBlob[nk]) (seen[nk] = 1), q.push(nk);
      }
    }
    let holes = 0;
    for (let k = 0; k < BW * BH; k++) if (!seen[k] && !inBlob[k]) holes++;
    if (holes < area * 0.08) continue;
    // 254 = 상자 흰 바탕, 253 = 상자 안 글자 자리
    for (let yy = 1; yy < BH - 1; yy++)
      for (let xx = 1; xx < BW - 1; xx++) {
        const k = yy * BW + xx;
        if (inBlob[k]) out[(y0 + yy - 1) * w + x0 + xx - 1] = 254;
        else if (!seen[k]) out[(y0 + yy - 1) * w + x0 + xx - 1] = 253;
      }
  }
  return { data: out, w, h };
}
