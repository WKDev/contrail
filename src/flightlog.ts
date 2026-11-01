// DJI 비행기록(DJIFlightRecord_*.txt) 요약 읽기. 비행 데이터 본문(v13+)은 암호화돼 DJI 키가 필요하지만,
// 앞부분 요약(시작 시각·위치·비행 시간·최고 고도/속도·기체명)은 키 없이 읽힌다. 형식은 dji-log-parser 의 Prefix/Details 와 같음.
export const RECORD_RE = /^DJIFlightRecord_.*\.txt$/i;

export interface FlightLog {
  name: string;
  version: number;
  start: number; // ms (UTC)
  duration: number; // 초
  distance: number; // m
  maxHeight: number; // m
  maxSpeed: number; // m/s (수평)
  maxVSpeed: number; // m/s
  videoTime: number; // 초 (기록 중 영상 녹화 시간)
  lat: number;
  lon: number;
  aircraft: string; // 예: "DJI Avata 2"
  aircraftSn: string; // 끝 4자리만 보관 (여러 기체 구분용)
}

const PREFIX = 100;

// CRC-64 (Jones, 반사형) — XOR 키 만들기용
let TAB: BigUint64Array | null = null;
function crc64(crc: bigint, data: Uint8Array) {
  if (!TAB) {
    TAB = new BigUint64Array(256);
    const P = 0x95ac9329ac4bc9b5n;
    for (let i = 0; i < 256; i++) {
      let c = BigInt(i);
      for (let k = 0; k < 8; k++) c = c & 1n ? (c >> 1n) ^ P : c >> 1n;
      TAB[i] = c;
    }
  }
  for (const b of data) crc = TAB[Number((crc ^ BigInt(b)) & 0xffn)] ^ (crc >> 8n);
  return crc;
}
const M64 = (1n << 64n) - 1n;
// 첫 바이트를 씨앗으로 8바이트 키를 만들어 이후 바이트를 XOR
function xorDecode(bytes: Uint8Array, recordType: number) {
  const seed = bytes[0];
  const mul = new Uint8Array(new BigUint64Array([(0x123456789abcdef0n * BigInt(seed)) & M64]).buffer);
  const key = new Uint8Array(new BigUint64Array([crc64(BigInt((seed + recordType) & 0xff), mul)]).buffer);
  const out = bytes.slice(1);
  for (let i = 0; i < out.length; i++) out[i] ^= key[i % 8];
  return out;
}

const str = (b: Uint8Array) => new TextDecoder().decode(b).replace(/\0[\s\S]*$/, "").trim();

// 요약(Details) 구조 (버전 6 이상)
function details(d: Uint8Array) {
  if (d.length < 380) throw new Error("short details");
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return {
    start: Number(v.getBigInt64(91, true)),
    lon: v.getFloat64(99, true),
    lat: v.getFloat64(107, true),
    distance: v.getFloat32(115, true),
    duration: v.getInt32(119, true) / 1000,
    maxHeight: v.getFloat32(123, true),
    maxSpeed: v.getFloat32(127, true),
    maxVSpeed: v.getFloat32(131, true),
    videoTime: Number(v.getBigInt64(139, true)) / 1000,
    aircraft: str(d.subarray(280, 312)),
    aircraftSn: str(d.subarray(312, 328)).slice(-4),
  };
}

// 파일 앞부분만 읽음 (v12 이상은 100바이트 뒤, 그 전 버전은 머리말이 가리키는 위치)
export async function readFlightLog(file: File): Promise<FlightLog> {
  const head = new DataView(await file.slice(0, PREFIX).arrayBuffer());
  if (head.byteLength < PREFIX) throw new Error("not a flight record");
  const version = head.getUint8(10);
  if (version < 6) throw new Error(`unsupported flight record v${version}`);
  const off = version < 12 ? Number(head.getBigUint64(0, true)) : PREFIX;
  const raw = new Uint8Array(await file.slice(off, off + 1200).arrayBuffer());
  let d: Uint8Array;
  if (version < 13) d = raw;
  else {
    // 첫 보조 블록: [0=정보][u16 크기][XOR: 버전 u8, 길이 u16, 요약…]
    if (raw[0] !== 0) throw new Error("missing info block");
    const size = raw[1] | (raw[2] << 8);
    const body = xorDecode(raw.subarray(3, 3 + size), 0);
    const len = body[1] | (body[2] << 8);
    d = body.subarray(3, 3 + len);
  }
  const x = details(d);
  if (!(x.start > 1.2e12 && x.start < 4e12) || !(x.duration >= 0 && x.duration < 86400)) throw new Error("bad flight record summary");
  return { name: file.name, version, ...x };
}

// 영상 [start, end] (ms) 와 가장 많이 겹치는 기록. 겹침이 없으면 앞뒤 2분 안에서 가장 가까운 것
export function matchLog(logs: FlightLog[], start: number, end: number): FlightLog | null {
  let best: FlightLog | null = null;
  let score = -Infinity;
  for (const l of logs) {
    const ls = l.start, le = l.start + l.duration * 1000;
    const overlap = Math.min(end, le) - Math.max(start, ls);
    const s = overlap > 0 ? overlap : overlap > -120_000 ? overlap - 1e9 : -Infinity;
    if (s > score) (score = s), (best = l);
  }
  return score === -Infinity ? null : best;
}
