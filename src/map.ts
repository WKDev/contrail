// 원형 미니맵: 기체 중심, 전체 궤적, 속도 기반 자동 배율.
// 배경 지도 = Google Map Tiles API (2D 위성 타일, 브라우저에서 CORS 허용). 키가 없으면 궤적만 표시.
import type { Telemetry } from "./telemetry.ts";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const D = Math.PI / 180;
const TILE = 256;
const MAX_Z = 20;

// Web Mercator 월드 좌표 (zoom 0 에서 0..256)
const mx = (lon: number) => ((lon + 180) / 360) * TILE;
const my = (lat: number) => {
  const s = Math.sin(lat * D);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE;
};
const metersPerWorldUnit = (lat: number) => (40075016.686 * Math.cos(lat * D)) / TILE;

export interface Track {
  t: Float64Array;
  x: Float64Array; // 월드 좌표 (z0)
  y: Float64Array;
  speed: Float32Array; // ±2초 이동평균 (m/s)
  home: { x: number; y: number } | null;
  lat0: number;
  bbox: { north: number; south: number; east: number; west: number } | null;
}

// GPS 가 유효한 샘플만 4Hz 정도로 추려 궤적 생성
export function buildTrack(tel: Telemetry): Track {
  const idx: number[] = [];
  let last = -Infinity;
  for (let i = 0; i < tel.t.length; i++) {
    if (Number.isNaN(tel.lat[i]) || (tel.lat[i] === 0 && tel.lon[i] === 0)) continue;
    if (tel.t[i] - last < 0.25) continue;
    idx.push(i);
    last = tel.t[i];
  }
  const n = idx.length;
  const tr: Track = {
    t: new Float64Array(n), x: new Float64Array(n), y: new Float64Array(n), speed: new Float32Array(n),
    home: null, lat0: n ? tel.lat[idx[0]] : 0, bbox: null,
  };
  const raw = new Float32Array(n);
  let north = -90, south = 90, east = -180, west = 180;
  idx.forEach((i, k) => {
    tr.t[k] = tel.t[i];
    tr.x[k] = mx(tel.lon[i]);
    tr.y[k] = my(tel.lat[i]);
    raw[k] = Math.hypot(tel.vx[i], tel.vy[i]);
    north = Math.max(north, tel.lat[i]); south = Math.min(south, tel.lat[i]);
    east = Math.max(east, tel.lon[i]); west = Math.min(west, tel.lon[i]);
  });
  // ±2초 이동평균
  for (let k = 0, a = 0, b = 0, sum = 0; k < n; k++) {
    while (b < n && tr.t[b] <= tr.t[k] + 2) sum += raw[b++];
    while (tr.t[a] < tr.t[k] - 2) sum -= raw[a++];
    tr.speed[k] = sum / (b - a);
  }
  if (n) {
    tr.home = { x: tr.x[0], y: tr.y[0] };
    tr.bbox = { north, south, east, west };
  }
  return tr;
}

function at(tr: Track, t: number) {
  const n = tr.t.length;
  if (!n) return null;
  if (t <= tr.t[0]) return { x: tr.x[0], y: tr.y[0], speed: tr.speed[0], k: 0 };
  if (t >= tr.t[n - 1]) return { x: tr.x[n - 1], y: tr.y[n - 1], speed: tr.speed[n - 1], k: n - 1 };
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (tr.t[m] <= t) lo = m;
    else hi = m;
  }
  const a = (t - tr.t[lo]) / (tr.t[hi] - tr.t[lo]);
  return {
    x: tr.x[lo] + (tr.x[hi] - tr.x[lo]) * a,
    y: tr.y[lo] + (tr.y[hi] - tr.y[lo]) * a,
    speed: tr.speed[lo] + (tr.speed[hi] - tr.speed[lo]) * a,
    k: lo,
  };
}

// 원 반지름이 나타내는 실제 거리: 약 12초 비행 거리, 60m ~ 2km.
// 지역 최대 zoom 이 낮으면(예: 한국 위성 ≈ z15) 타일을 2배 이상 확대하지 않도록 최소 반경을 키운다.
export function viewRadiusMeters(speed: number, R: number, lat: number, maxZoom: number) {
  const minByTiles = (R * metersPerWorldUnit(lat)) / 2 ** maxZoom / 2;
  return Math.min(2000, Math.max(60, minByTiles, speed * 12));
}

// 원 반지름 R(px) 에 radiusM(m) 가 들어가는 연속 zoom
const zoomFor = (R: number, radiusM: number, lat: number) => Math.log2((R * metersPerWorldUnit(lat)) / radiusM);

// ---------- 타일 ----------
export class TileSource {
  private cache = new Map<string, ImageBitmap | null>();
  private pending = new Map<string, Promise<void>>();
  private session: Promise<string> | null = null;
  copyright = "";
  maxZoom = MAX_Z; // 404 를 받으면 낮아짐
  private key: string;
  private mapType: "satellite" | "roadmap";
  constructor(key: string, mapType: "satellite" | "roadmap" = "satellite") {
    this.key = key;
    this.mapType = mapType;
  }

  private getSession() {
    this.session ??= fetch(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(this.key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mapType: this.mapType, language: "ko-KR", region: "KR" }),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`Map Tiles 세션 실패 ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return (await r.json()).session as string;
    });
    return this.session;
  }

  get(z: number, x: number, y: number) {
    return this.cache.get(`${z}/${x}/${y}`);
  }

  load(z: number, x: number, y: number): Promise<void> {
    const k = `${z}/${x}/${y}`;
    if (this.cache.has(k)) return Promise.resolve();
    let p = this.pending.get(k);
    if (!p) {
      p = this.getSession()
        .then((s) => fetch(`https://tile.googleapis.com/v1/2dtiles/${z}/${x}/${y}?session=${s}&key=${encodeURIComponent(this.key)}`))
        .then(async (r) => {
          if (r.status === 404 && z > 0) this.maxZoom = Math.min(this.maxZoom, z - 1); // 이 지역 최대 zoom 초과
          return r.ok ? createImageBitmap(await r.blob()) : null;
        })
        .catch(() => null)
        .then((img) => {
          this.cache.set(k, img);
          this.pending.delete(k);
        });
      this.pending.set(k, p);
    }
    return p;
  }

  async loadAttribution(bbox: NonNullable<Track["bbox"]>, zoom: number) {
    try {
      const s = await this.getSession();
      const pad = 0.01;
      const q = new URLSearchParams({
        session: s, key: this.key, zoom: String(Math.round(zoom)),
        north: String(Math.min(89, bbox.north + pad)), south: String(Math.max(-89, bbox.south - pad)),
        east: String(bbox.east + pad), west: String(bbox.west - pad),
      });
      const r = await fetch(`https://tile.googleapis.com/tile/v1/viewport?${q}`);
      if (r.ok) this.copyright = (await r.json()).copyright ?? "";
    } catch {}
  }

  // 렌더 전 전체 궤적에 필요한 타일 미리 받기
  async prefetch(tr: Track, R: number, onProgress?: (d: number, t: number) => void) {
    await this.getSession(); // 키 오류는 여기서 throw
    const need = new Set<string>();
    // 404 로 maxZoom 이 내려가면 필요한 타일 목록이 바뀌므로 반복
    for (let round = 0; round < 8; round++) {
      const before = this.maxZoom;
      const need = new Set<string>();
      for (let k = 0; k < tr.t.length; k += 2) for (const key of tilesFor(tr.x[k], tr.y[k], tr.speed[k], R, tr.lat0, this.maxZoom)) need.add(key);
      const list = [...need].filter((k) => !this.cache.has(k));
      let done = 0;
      const total = list.length;
      const worker = async () => {
        while (list.length) {
          const [z, x, y] = list.pop()!.split("/").map(Number);
          if (z <= this.maxZoom) await this.load(z, x, y);
          onProgress?.(++done, total);
        }
      };
      await Promise.all(Array.from({ length: 8 }, worker));
      if (this.maxZoom === before) break;
    }
    if (tr.bbox) await this.loadAttribution(tr.bbox, this.maxZoom);
  }
}

function view(speed: number, R: number, lat: number, maxZoom: number) {
  const radiusM = viewRadiusMeters(speed, R, lat, maxZoom);
  const z = zoomFor(R, radiusM, lat);
  const tz = Math.max(0, Math.min(maxZoom, Math.ceil(z)));
  return { z, tz, scale: 2 ** (z - tz), radiusM };
}

function tilesFor(cxw: number, cyw: number, speed: number, R: number, lat: number, maxZoom: number) {
  const { tz, scale } = view(speed, R, lat, maxZoom);
  const n = 2 ** tz;
  const px = cxw * n, py = cyw * n;
  const half = R / scale;
  const out: string[] = [];
  for (let tx = Math.floor((px - half) / TILE); tx <= Math.floor((px + half) / TILE); tx++)
    for (let ty = Math.floor((py - half) / TILE); ty <= Math.floor((py + half) / TILE); ty++)
      if (ty >= 0 && ty < n) out.push(`${tz}/${((tx % n) + n) % n}/${ty}`);
  return out;
}

// ---------- 그리기 ----------
export interface MapStyle {
  face: string; // 지도 없을 때 바탕
  ring: string | null; // 바깥 테두리 (null = 없음)
  track: string; // 지나온 궤적
  accent: string; // 기체·이륙 지점
  north: string;
  line: number; // 선 굵기 배율
}
export const MAP_STYLE: MapStyle = { face: "rgba(15, 18, 24, 0.7)", ring: "rgba(255,255,255,0.9)", track: "#4fd1ff", accent: "#ffd23f", north: "#ff6b5b", line: 1 };

export function drawMap(ctx: Ctx, cx: number, cy: number, R: number, s: number, tr: Track, t: number, heading: number, tiles: TileSource | null, label: (text: string, x: number, y: number, size: number, align?: CanvasTextAlign, color?: string) => void, st: MapStyle = MAP_STYLE) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = st.face;
  ctx.fillRect(-R, -R, R * 2, R * 2);

  const c = at(tr, t);
  if (!c) {
    ctx.restore();
    label("NO GPS", 0, 0, 20 * s);
    ring(ctx, R, s, st);
    ctx.restore();
    return;
  }
  const { z, tz, scale, radiusM } = view(c.speed, R, tr.lat0, tiles?.maxZoom ?? MAX_Z);

  // 타일
  if (tiles) {
    const n = 2 ** tz;
    const px = c.x * n, py = c.y * n;
    const half = R / scale;
    const size = TILE * scale;
    for (let tx = Math.floor((px - half) / TILE); tx <= Math.floor((px + half) / TILE); tx++)
      for (let ty = Math.floor((py - half) / TILE); ty <= Math.floor((py + half) / TILE); ty++) {
        if (ty < 0 || ty >= n) continue;
        const wx = ((tx % n) + n) % n;
        const img = tiles.get(tz, wx, ty);
        if (img === undefined) tiles.load(tz, wx, ty); // 미리보기: 비동기 로드, 다음 프레임에 표시
        if (img) ctx.drawImage(img, Math.floor((tx * TILE - px) * scale), Math.floor((ty * TILE - py) * scale), Math.ceil(size) + 1, Math.ceil(size) + 1);
      }
    ctx.fillStyle = "rgba(0,0,0,0.15)";
    ctx.fillRect(-R, -R, R * 2, R * 2);
  } else {
    // 지도 없음: 거리 링
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1 * s;
    for (const f of [0.33, 0.66]) {
      ctx.beginPath();
      ctx.arc(0, 0, R * f, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // 궤적 (지나온 길 = 진하게, 앞으로 = 흐리게)
  const k2 = 2 ** z;
  const P = (k: number) => [(tr.x[k] - c.x) * k2, (tr.y[k] - c.y) * k2] as const;
  const path = (from: number, to: number, endAtCenter: boolean) => {
    ctx.beginPath();
    for (let k = from; k <= to; k++) {
      const [x, y] = P(k);
      k === from ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    if (endAtCenter) ctx.lineTo(0, 0);
  };
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash([6 * s, 6 * s]);
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  for (let k = c.k + 1; k < tr.t.length; k++) ctx.lineTo(...P(k));
  ctx.stroke();
  ctx.setLineDash([]);
  path(0, c.k, true);
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.lineWidth = 6 * s;
  ctx.stroke();
  ctx.strokeStyle = st.track;
  ctx.lineWidth = 3 * s * st.line;
  ctx.stroke();

  // 이륙 지점
  if (tr.home) {
    const hx = (tr.home.x - c.x) * k2, hy = (tr.home.y - c.y) * k2;
    if (Math.hypot(hx, hy) < R - 10 * s) {
      ctx.fillStyle = st.accent;
      ctx.beginPath();
      ctx.arc(hx, hy, 9 * s, 0, Math.PI * 2);
      ctx.fill();
      label("H", hx, hy + 0.5 * s, 12 * s, "center", "#111");
    }
  }

  // 기체 (중심, 북쪽 위 고정 지도에서 방위만큼 회전)
  ctx.rotate(heading * D);
  ctx.fillStyle = st.accent;
  ctx.strokeStyle = "rgba(0,0,0,0.7)";
  ctx.lineWidth = 2.5 * s;
  ctx.beginPath();
  ctx.moveTo(0, -14 * s);
  ctx.lineTo(10 * s, 10 * s);
  ctx.lineTo(0, 5 * s);
  ctx.lineTo(-10 * s, 10 * s);
  ctx.closePath();
  ctx.stroke();
  ctx.fill();
  ctx.restore();

  ring(ctx, R, s, st);
  label("N", 0, -R + 14 * s, 15 * s, "center", st.north);
  const rm = radiusM;
  label(rm >= 1000 ? `r ${(rm / 1000).toFixed(1)} km` : `r ${Math.round(rm / 10) * 10} m`, 0, R - 16 * s, 13 * s);
  if (tiles?.copyright) label(tiles.copyright, 0, R + 16 * s, 9 * s, "center", "rgba(255,255,255,0.85)");
  ctx.restore();
}

function ring(ctx: Ctx, R: number, s: number, st: MapStyle) {
  if (!st.ring) return;
  ctx.strokeStyle = "rgba(20,20,20,0.85)";
  ctx.lineWidth = 6 * s * st.line;
  ctx.beginPath();
  ctx.arc(0, 0, R + 3 * s, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = st.ring;
  ctx.lineWidth = 1.5 * s * st.line;
  ctx.beginPath();
  ctx.arc(0, 0, R + 6 * s, 0, Math.PI * 2);
  ctx.stroke();
}

// 이륙 지점(궤적 첫 점)에서 지금 위치까지 수평 거리 (m). GPS 없으면 NaN
export function homeDistance(tr: Track | null | undefined, lat: number, lon: number) {
  if (!tr?.home || Number.isNaN(lat) || Number.isNaN(lon) || (lat === 0 && lon === 0)) return NaN;
  return Math.hypot(mx(lon) - tr.home.x, my(lat) - tr.home.y) * metersPerWorldUnit(tr.lat0);
}
