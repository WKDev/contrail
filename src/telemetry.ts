// DJI 영상 내장 메타데이터(djmd 트랙, protobuf) → 프레임별 비행 데이터.
// Avata 2 (dvtm_AVATA2.proto) 실측 필드 경로. 스키마는 telemetry-parser 의 dvtm_library.proto 참고:
//   ProductMeta.frame_meta(3)
//     .drone(4).velocity(2)        {x,y,z: float m/s}
//     .drone(4).attitude(3)        EulerAngle {pitch,roll,yaw: int32 decidegree}
//     .drone(4).gps(4)             {coords(1){lat(2),lon(3): double rad}, altitude_mm(2): int32}
//     .drone(4).rel_altitude(5)    {relative_altitude_mm(1): float}
import { parse, type Reader } from "./mp4.ts";

export interface Telemetry {
  t: Float64Array; // 영상 기준 시간(초)
  pitch: Float32Array; // 도. 음수 = 기수 하강
  roll: Float32Array; // 도. 양수 = 오른쪽 기울임
  yaw: Float32Array; // 도 (진북 기준, -180~180)
  vx: Float32Array; // m/s
  vy: Float32Array;
  vz: Float32Array;
  lat: Float64Array; // 도, 없으면 NaN
  lon: Float64Array;
  relAlt: Float32Array; // m (이륙 지점 기준), 없으면 NaN
}

type Field = { f: number; wire: number; v: number | bigint | Uint8Array };

function* fields(b: Uint8Array): Generator<Field> {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 0;
  const varint = () => {
    let r = 0n;
    let s = 0n;
    for (;;) {
      if (p >= b.length) throw new Error("truncated varint");
      const c = b[p++];
      r |= BigInt(c & 0x7f) << s;
      s += 7n;
      if (c < 0x80) return r;
    }
  };
  while (p < b.length) {
    const key = Number(varint());
    const f = key >>> 3;
    const wire = key & 7;
    if (wire === 0) yield { f, wire, v: varint() };
    else if (wire === 5) {
      yield { f, wire, v: dv.getFloat32(p, true) };
      p += 4;
    } else if (wire === 1) {
      yield { f, wire, v: dv.getFloat64(p, true) };
      p += 8;
    } else if (wire === 2) {
      const len = Number(varint());
      yield { f, wire, v: b.subarray(p, p + len) };
      p += len;
    } else throw new Error(`unsupported wire type ${wire}`);
  }
}

const sub = (b: Uint8Array | undefined, f: number) => {
  if (!b) return undefined;
  for (const x of fields(b)) if (x.f === f && x.wire === 2) return x.v as Uint8Array;
  return undefined;
};
const num = (b: Uint8Array | undefined, f: number): number | undefined => {
  if (!b) return undefined;
  for (const x of fields(b)) {
    if (x.f !== f) continue;
    if (x.wire === 0) return Number(BigInt.asIntN(32, x.v as bigint)); // int32 (음수는 64bit 부호확장)
    if (x.wire === 1 || x.wire === 5) return x.v as number;
  }
  return undefined;
};

export function decodeSample(b: Uint8Array) {
  const drone = sub(sub(b, 3), 4);
  if (!drone) return null;
  const att = sub(drone, 3);
  const vel = sub(drone, 2);
  const gps = sub(drone, 4);
  const coord = sub(gps, 1);
  const lat = num(coord, 2);
  const lon = num(coord, 3);
  const rel = num(sub(drone, 5), 1);
  return {
    // proto3: 0 인 필드는 생략됨
    pitch: (num(att, 1) ?? 0) / 10,
    roll: (num(att, 2) ?? 0) / 10,
    yaw: (num(att, 3) ?? 0) / 10,
    vx: num(vel, 1) ?? 0,
    vy: num(vel, 2) ?? 0,
    vz: num(vel, 3) ?? 0,
    lat: lat !== undefined && lon !== undefined ? (lat * 180) / Math.PI : NaN,
    lon: lat !== undefined && lon !== undefined ? (lon * 180) / Math.PI : NaN,
    relAlt: rel !== undefined ? rel / 1000 : NaN,
  };
}

export async function readTelemetry(r: Reader): Promise<Telemetry> {
  const tr = await parse(r, "djmd");
  const n = tr.count;
  const out: Telemetry = {
    t: new Float64Array(n),
    pitch: new Float32Array(n),
    roll: new Float32Array(n),
    yaw: new Float32Array(n),
    vx: new Float32Array(n),
    vy: new Float32Array(n),
    vz: new Float32Array(n),
    lat: new Float64Array(n).fill(NaN),
    lon: new Float64Array(n).fill(NaN),
    relAlt: new Float32Array(n).fill(NaN),
  };
  // 샘플들이 파일 곳곳에 흩어져 있으므로 큰 창 단위로 읽음
  const WINDOW = 8 * 1024 * 1024;
  let winStart = 0;
  let win: Uint8Array = new Uint8Array();
  let time = 0;
  let k = 0;
  for (let i = 0; i < n; i++) {
    const off = tr.offsets[i];
    const size = tr.sizes[i];
    const t = time / tr.timescale;
    time += tr.deltas[i];
    if (off < winStart || off + size > winStart + win.length) {
      winStart = off;
      win = await r.read(off, Math.min(Math.max(WINDOW, size), r.size - off));
    }
    let d: ReturnType<typeof decodeSample> = null;
    try {
      d = decodeSample(win.subarray(off - winStart, off - winStart + size));
    } catch {}
    if (!d) continue; // 첫 샘플(clip 메타) 등
    out.t[k] = t;
    out.pitch[k] = d.pitch;
    out.roll[k] = d.roll;
    out.yaw[k] = d.yaw;
    out.vx[k] = d.vx;
    out.vy[k] = d.vy;
    out.vz[k] = d.vz;
    out.lat[k] = d.lat;
    out.lon[k] = d.lon;
    out.relAlt[k] = d.relAlt;
    k++;
  }
  return slice(out, 0, k);
}

function slice(t: Telemetry, a: number, b: number): Telemetry {
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.slice(a, b)])) as unknown as Telemetry;
}

// 병합 영상용: 시간 오프셋을 더해 이어붙임
export function concatTelemetry(parts: Telemetry[], durations: number[]): Telemetry {
  const n = parts.reduce((a, p) => a + p.t.length, 0);
  const keys = Object.keys(parts[0]) as (keyof Telemetry)[];
  const out = Object.fromEntries(keys.map((k) => [k, new (parts[0][k].constructor as any)(n)])) as unknown as Telemetry;
  let pos = 0;
  let offset = 0;
  parts.forEach((p, i) => {
    for (const k of keys) (out[k] as Float64Array).set(p[k] as Float64Array, pos);
    for (let j = 0; j < p.t.length; j++) out.t[pos + j] += offset;
    pos += p.t.length;
    offset += durations[i];
  });
  return out;
}

export const toJSON = (t: Telemetry) => JSON.stringify(Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Array.from(v as ArrayLike<number>, (x) => (Number.isNaN(x) ? null : Math.round(x * 1e7) / 1e7))])));
export function fromJSON(s: string): Telemetry {
  const o = JSON.parse(s);
  const mk = (k: string, C: any) => C.from(o[k], (x: number | null) => (x === null ? NaN : x));
  return {
    t: mk("t", Float64Array), pitch: mk("pitch", Float32Array), roll: mk("roll", Float32Array), yaw: mk("yaw", Float32Array),
    vx: mk("vx", Float32Array), vy: mk("vy", Float32Array), vz: mk("vz", Float32Array),
    lat: mk("lat", Float64Array), lon: mk("lon", Float64Array), relAlt: mk("relAlt", Float32Array),
  };
}

// 시간 t(초)에서의 값 (이진 탐색 + 선형 보간, yaw 는 각도 래핑 고려)
export function sampleAt(tel: Telemetry, t: number) {
  const ts = tel.t;
  const n = ts.length;
  if (!n) return null;
  let lo = 0;
  let hi = n - 1;
  if (t <= ts[0]) hi = 0;
  else if (t >= ts[n - 1]) lo = hi = n - 1;
  else
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (ts[m] <= t) lo = m;
      else hi = m;
    }
  const a = (lo === hi ? 0 : (t - ts[lo]) / (ts[hi] - ts[lo])) || 0;
  const L = (x: ArrayLike<number>) => x[lo] + (x[hi] - x[lo]) * a;
  let dy = tel.yaw[hi] - tel.yaw[lo];
  if (dy > 180) dy -= 360;
  if (dy < -180) dy += 360;
  const yaw = tel.yaw[lo] + dy * a;
  return {
    pitch: L(tel.pitch), roll: L(tel.roll), heading: ((yaw % 360) + 360) % 360,
    vx: L(tel.vx), vy: L(tel.vy), vz: L(tel.vz),
    speed: Math.hypot(L(tel.vx), L(tel.vy), L(tel.vz)),
    lat: L(tel.lat), lon: L(tel.lon), relAlt: L(tel.relAlt),
  };
}
export type TelemetryPoint = NonNullable<ReturnType<typeof sampleAt>>;
