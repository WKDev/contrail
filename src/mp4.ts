// 최소 MP4 파서/병합기. 재인코딩 없이 첫 번째 비디오 트랙의 샘플만 이어붙인다.
// 브라우저(File.slice)와 Node(fs) 모두에서 쓰도록 Reader/Writer 인터페이스만 의존한다.
// 출력 레이아웃: ftyp | moov(co64) | mdat(64bit)  → faststart, 순차 쓰기 가능.

export interface Reader {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}
export interface Writer {
  write(chunk: Uint8Array): Promise<void>;
}

interface Box {
  type: string;
  start: number; // payload 시작 (상대)
  end: number;
  raw: Uint8Array; // 헤더 포함 전체
}

const td = new TextDecoder("latin1");

function children(buf: Uint8Array, from = 0, to = buf.length): Box[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: Box[] = [];
  let p = from;
  while (p + 8 <= to) {
    let size = dv.getUint32(p);
    const type = td.decode(buf.subarray(p + 4, p + 8));
    let hdr = 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(p + 8));
      hdr = 16;
    } else if (size === 0) size = to - p;
    if (size < hdr) break;
    out.push({ type, start: p + hdr, end: p + size, raw: buf.subarray(p, p + size) });
    p += size;
  }
  return out;
}

function find(buf: Uint8Array, box: Box | null, path: string[]): Box | null {
  let cur = box;
  for (const t of path) {
    const list = cur ? children(buf, cur.start, cur.end) : children(buf);
    cur = list.find((b) => b.type === t) ?? null;
    if (!cur) return null;
  }
  return cur;
}

export interface Track {
  ftyp: Uint8Array;
  mvhd: Uint8Array;
  tkhd: Uint8Array;
  mdhd: Uint8Array;
  hdlr: Uint8Array;
  vmhd: Uint8Array | null;
  dinf: Uint8Array | null;
  stsd: Uint8Array;
  elstMediaTime: number | null;
  timescale: number; // media timescale
  creationTime: number | null; // mvhd 생성 시각 (epoch ms, UTC)
  movieTimescale: number;
  duration: number; // seconds
  width: number;
  height: number;
  count: number;
  offsets: Float64Array;
  sizes: Uint32Array;
  deltas: Uint32Array;
  cts: Int32Array | null;
  sync: Uint32Array | null; // 1-based, null = 전부 키프레임
}

async function topLevel(r: Reader) {
  const boxes: { type: string; pos: number; size: number }[] = [];
  let p = 0;
  while (p + 8 <= r.size) {
    const h = await r.read(p, 16);
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let size = dv.getUint32(0);
    const type = td.decode(h.subarray(4, 8));
    if (size === 1) size = Number(dv.getBigUint64(8));
    else if (size === 0) size = r.size - p;
    if (size < 8) throw new Error(`잘못된 MP4 박스 @${p}`);
    boxes.push({ type, pos: p, size });
    p += size;
  }
  return boxes;
}

// kind: "video" = 첫 번째 비디오 트랙, 그 외 = stsd 엔트리 타입이 일치하는 트랙 (예: DJI 메타데이터 "djmd")
export async function parse(r: Reader, kind = "video"): Promise<Track> {
  const top = await topLevel(r);
  const ftypB = top.find((b) => b.type === "ftyp");
  const moovB = top.find((b) => b.type === "moov");
  if (!moovB) throw new Error("moov 박스 없음 (녹화가 비정상 종료된 파일?)");
  const ftyp = ftypB ? await r.read(ftypB.pos, ftypB.size) : new Uint8Array();
  const buf = await r.read(moovB.pos, moovB.size);
  const moov = children(buf)[0];
  const mvhd = find(buf, moov, ["mvhd"])!;
  const trak = children(buf, moov.start, moov.end).find((b) => {
    if (b.type !== "trak") return false;
    if (kind === "video") return td.decode(find(buf, b, ["mdia", "hdlr"])!.raw.subarray(16, 20)) === "vide";
    const stsd = find(buf, b, ["mdia", "minf", "stbl", "stsd"]);
    return !!stsd && td.decode(stsd.raw.subarray(20, 24)) === kind;
  });
  if (!trak) throw new Error(kind === "video" ? "비디오 트랙 없음" : `${kind} 트랙 없음`);
  const g = (path: string[]) => find(buf, trak, path);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u32 = (p: number) => dv.getUint32(p);

  const mdhd = g(["mdia", "mdhd"])!;
  const v1 = buf[mdhd.start] === 1;
  const timescale = u32(mdhd.start + (v1 ? 20 : 12));
  const mvv1 = buf[mvhd.start] === 1;
  const movieTimescale = u32(mvhd.start + (mvv1 ? 20 : 12));
  // 1904-01-01 기준 초 → epoch ms (0 이거나 비정상이면 null)
  const created = mvv1 ? Number(dv.getBigUint64(mvhd.start + 4)) : u32(mvhd.start + 4);
  const creationTime = created > 3_600_000_000 ? (created - 2082844800) * 1000 : null;
  const tkhd = g(["tkhd"])!;
  const width = u32(tkhd.end - 8) / 65536;
  const height = u32(tkhd.end - 4) / 65536;

  let elstMediaTime: number | null = null;
  const elst = g(["edts", "elst"]);
  if (elst && u32(elst.start + 4) === 1) {
    elstMediaTime = buf[elst.start] === 1 ? Number(dv.getBigInt64(elst.start + 16)) : dv.getInt32(elst.start + 12);
  }

  const stbl = g(["mdia", "minf", "stbl"])!;
  const sb = (t: string) => find(buf, stbl, [t]);

  const stsz = sb("stsz")!;
  const fixed = u32(stsz.start + 4);
  const count = u32(stsz.start + 8);
  const sizes = new Uint32Array(count);
  for (let i = 0; i < count; i++) sizes[i] = fixed || u32(stsz.start + 12 + i * 4);

  const deltas = new Uint32Array(count);
  {
    const b = sb("stts")!;
    let k = 0;
    for (let e = 0, n = u32(b.start + 4); e < n; e++) {
      const c = u32(b.start + 8 + e * 8);
      const d = u32(b.start + 12 + e * 8);
      for (let j = 0; j < c && k < count; j++) deltas[k++] = d;
    }
  }

  let cts: Int32Array | null = null;
  const cttsB = sb("ctts");
  if (cttsB) {
    cts = new Int32Array(count);
    let k = 0;
    for (let e = 0, n = u32(cttsB.start + 4); e < n; e++) {
      const c = u32(cttsB.start + 8 + e * 8);
      const o = dv.getInt32(cttsB.start + 12 + e * 8);
      for (let j = 0; j < c && k < count; j++) cts[k++] = o;
    }
  }

  let sync: Uint32Array | null = null;
  const stss = sb("stss");
  if (stss) {
    const n = u32(stss.start + 4);
    sync = new Uint32Array(n);
    for (let i = 0; i < n; i++) sync[i] = u32(stss.start + 8 + i * 4);
  }

  // 청크 오프셋 → 샘플 오프셋
  const co64 = sb("co64");
  const stco = co64 ?? sb("stco")!;
  const nChunks = u32(stco.start + 4);
  const chunkOff = (i: number) =>
    co64 ? Number(dv.getBigUint64(stco.start + 8 + i * 8)) : u32(stco.start + 8 + i * 4);
  const stsc = sb("stsc")!;
  const nStsc = u32(stsc.start + 4);
  const offsets = new Float64Array(count);
  let s = 0;
  for (let e = 0; e < nStsc; e++) {
    const first = u32(stsc.start + 8 + e * 12) - 1;
    const per = u32(stsc.start + 12 + e * 12);
    const last = e + 1 < nStsc ? u32(stsc.start + 8 + (e + 1) * 12) - 1 : nChunks;
    for (let c = first; c < last; c++) {
      let off = chunkOff(c);
      for (let j = 0; j < per && s < count; j++) {
        offsets[s] = off;
        off += sizes[s++];
      }
    }
  }

  let total = 0;
  for (let i = 0; i < count; i++) total += deltas[i];

  return {
    ftyp,
    mvhd: mvhd.raw.slice(),
    tkhd: tkhd.raw.slice(),
    mdhd: mdhd.raw.slice(),
    hdlr: g(["mdia", "hdlr"])!.raw.slice(),
    vmhd: g(["mdia", "minf", "vmhd"])?.raw.slice() ?? null,
    dinf: g(["mdia", "minf", "dinf"])?.raw.slice() ?? null,
    stsd: sb("stsd")!.raw.slice(),
    elstMediaTime,
    timescale,
    creationTime,
    movieTimescale,
    duration: total / timescale,
    width,
    height,
    count,
    offsets,
    sizes,
    deltas,
    cts,
    sync,
  };
}

// ---------- writer helpers ----------

class Buf {
  parts: Uint8Array[] = [];
  len = 0;
  u8(v: number) { this.push(new Uint8Array([v])); }
  u32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v); this.push(b); }
  i32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v); this.push(b); }
  u64(v: number) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v)); this.push(b); }
  push(b: Uint8Array) { this.parts.push(b); this.len += b.length; }
  bytes() {
    const out = new Uint8Array(this.len);
    let p = 0;
    for (const b of this.parts) { out.set(b, p); p += b.length; }
    return out;
  }
}

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const b = new Buf();
  const len = 8 + payload.reduce((a, p) => a + p.length, 0);
  b.u32(len);
  b.push(new TextEncoder().encode(type));
  payload.forEach((p) => b.push(p));
  return b.bytes();
}

function fullbox(type: string, version: number, fill: (b: Buf) => void) {
  const b = new Buf();
  b.u32(version << 24);
  fill(b);
  return box(type, b.bytes());
}

// mvhd / tkhd / mdhd 의 duration 필드를 덮어쓴다 (version 0 에서 넘치면 실패 대신 32bit 최댓값)
function patchDuration(raw: Uint8Array, kind: "mvhd" | "tkhd" | "mdhd", duration: number) {
  const out = raw.slice();
  const dv = new DataView(out.buffer);
  const v1 = out[8] === 1;
  const pos = kind === "tkhd" ? (v1 ? 36 : 28) : v1 ? 32 : 24;
  if (v1) dv.setBigUint64(pos, BigInt(duration));
  else dv.setUint32(pos, Math.min(duration, 0xffffffff));
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function buildMoov(tracks: Track[], mdatData: number) {
  const t0 = tracks[0];
  const count = tracks.reduce((a, t) => a + t.count, 0);
  let mediaDur = 0;
  tracks.forEach((t) => t.deltas.forEach((d) => (mediaDur += d)));
  const movieDur = Math.round((mediaDur / t0.timescale) * t0.movieTimescale);

  const stts = fullbox("stts", 0, (b) => {
    const runs: [number, number][] = [];
    for (const t of tracks)
      for (const d of t.deltas) {
        const last = runs[runs.length - 1];
        if (last && last[1] === d) last[0]++;
        else runs.push([1, d]);
      }
    b.u32(runs.length);
    runs.forEach(([c, d]) => { b.u32(c); b.u32(d); });
  });

  const anyCts = tracks.some((t) => t.cts);
  const ctts = anyCts
    ? fullbox("ctts", 0, (b) => {
        const runs: [number, number][] = [];
        for (const t of tracks)
          for (let i = 0; i < t.count; i++) {
            const o = t.cts ? t.cts[i] : 0;
            const last = runs[runs.length - 1];
            if (last && last[1] === o) last[0]++;
            else runs.push([1, o]);
          }
        b.u32(runs.length);
        runs.forEach(([c, o]) => { b.u32(c); b.i32(o); });
      })
    : null;

  const anySync = tracks.some((t) => t.sync);
  const stss = anySync
    ? fullbox("stss", 0, (b) => {
        const idx: number[] = [];
        let base = 0;
        for (const t of tracks) {
          if (t.sync) t.sync.forEach((s) => idx.push(base + s));
          else for (let i = 1; i <= t.count; i++) idx.push(base + i);
          base += t.count;
        }
        b.u32(idx.length);
        idx.forEach((v) => b.u32(v));
      })
    : null;

  const stsz = fullbox("stsz", 0, (b) => {
    b.u32(0);
    b.u32(count);
    tracks.forEach((t) => t.sizes.forEach((s) => b.u32(s)));
  });
  // 샘플 1개 = 청크 1개
  const stsc = fullbox("stsc", 0, (b) => { b.u32(1); b.u32(1); b.u32(1); b.u32(1); });
  const co64 = fullbox("co64", 0, (b) => {
    b.u32(count);
    let off = mdatData;
    tracks.forEach((t) => t.sizes.forEach((s) => { b.u64(off); off += s; }));
  });

  const stbl = box("stbl", t0.stsd, stts, ...(ctts ? [ctts] : []), ...(stss ? [stss] : []), stsc, stsz, co64);
  const minf = box("minf", ...(t0.vmhd ? [t0.vmhd] : []), ...(t0.dinf ? [t0.dinf] : []), stbl);
  const mdia = box("mdia", patchDuration(t0.mdhd, "mdhd", mediaDur), t0.hdlr, minf);
  const edts =
    t0.elstMediaTime !== null
      ? [box("edts", fullbox("elst", 1, (b) => { b.u32(1); b.u64(movieDur); b.u64(t0.elstMediaTime!); b.u32(0x00010000); }))]
      : [];
  const trak = box("trak", patchDuration(t0.tkhd, "tkhd", movieDur), ...edts, mdia);
  return box("moov", patchDuration(t0.mvhd, "mvhd", movieDur), trak);
}

export function checkCompatible(tracks: Track[]) {
  const t0 = tracks[0];
  for (const t of tracks.slice(1)) {
    if (t.timescale !== t0.timescale) throw new Error("timescale 이 서로 달라 병합 불가");
    if (!sameBytes(t.stsd, t0.stsd)) throw new Error("코덱 설정(stsd)이 서로 달라 병합 불가");
  }
}

export async function merge(
  inputs: Reader[],
  out: Writer,
  onProgress?: (done: number, total: number) => void,
  tracks?: Track[],
) {
  tracks ??= await Promise.all(inputs.map((r) => parse(r)));
  checkCompatible(tracks);

  const dataSize = tracks.reduce((a, t) => a + t.sizes.reduce((x, y) => x + y, 0), 0);
  const ftyp = tracks[0].ftyp;
  const moovLen = buildMoov(tracks, 0).length;
  const mdatData = ftyp.length + moovLen + 16;
  const moov = buildMoov(tracks, mdatData);
  if (moov.length !== moovLen) throw new Error("moov 크기 불일치");

  const mdatHdr = new Buf();
  mdatHdr.u32(1);
  mdatHdr.push(new TextEncoder().encode("mdat"));
  mdatHdr.u64(16 + dataSize);
  await out.write(ftyp);
  await out.write(moov);
  await out.write(mdatHdr.bytes());

  const WINDOW = 32 * 1024 * 1024;
  const FLUSH = 16 * 1024 * 1024;
  let done = 0;
  let pending = new Buf();
  for (let k = 0; k < tracks.length; k++) {
    const t = tracks[k];
    const r = inputs[k];
    let winStart = 0;
    let win: Uint8Array = new Uint8Array();
    for (let i = 0; i < t.count; i++) {
      const off = t.offsets[i];
      const size = t.sizes[i];
      if (off < winStart || off + size > winStart + win.length) {
        winStart = off;
        win = await r.read(off, Math.min(Math.max(WINDOW, size), r.size - off));
      }
      pending.push(win.subarray(off - winStart, off - winStart + size));
      done += size;
      if (pending.len >= FLUSH) {
        await out.write(pending.bytes());
        pending = new Buf();
        onProgress?.(done, dataSize);
      }
    }
  }
  if (pending.len) await out.write(pending.bytes());
  onProgress?.(done, dataSize);
  return { size: mdatData + dataSize, duration: tracks.reduce((a, t) => a + t.duration, 0) };
}
