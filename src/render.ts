// HUD 를 영상에 합성 (WebCodecs: HEVC 디코드 → 캔버스 합성 → H.264 인코드 → MP4)
import { buildMoov, parse, type Reader, type Track } from "./mp4.ts";
import { drawHud } from "./hud.ts";
import { buildTrack, TileSource } from "./map.ts";
import { fileReader } from "./frames.ts";
import type { Box, Layout, OsdMask } from "./store.ts";
import { keyBlack, keyWhite, type StaticMask } from "./osdkey.ts";
import { sampleAt, type Telemetry } from "./telemetry.ts";

export interface SeekWriter {
  write(chunk: Uint8Array): Promise<void>;
  writeAt(position: number, chunk: Uint8Array): Promise<void>;
}

function findBox(b: Uint8Array, type: string) {
  const t = [...type].map((c) => c.charCodeAt(0));
  for (let i = 4; i + 4 <= b.length; i++) {
    if (b[i] === t[0] && b[i + 1] === t[1] && b[i + 2] === t[2] && b[i + 3] === t[3]) {
      const size = new DataView(b.buffer, b.byteOffset + i - 4, 4).getUint32(0);
      return b.subarray(i + 4, i - 4 + size);
    }
  }
  return null;
}

// hvcC → WebCodecs 코덱 문자열 (ISO/IEC 14496-15 Annex E)
export function hevcCodec(hvcC: Uint8Array) {
  const space = hvcC[1] >> 6;
  const tier = (hvcC[1] >> 5) & 1;
  const profile = hvcC[1] & 0x1f;
  let compat = new DataView(hvcC.buffer, hvcC.byteOffset + 2, 4).getUint32(0);
  let rev = 0;
  for (let i = 0; i < 32; i++) {
    rev = (rev << 1) | (compat & 1);
    compat >>>= 1;
  }
  const cons = Array.from(hvcC.subarray(6, 12));
  while (cons.length && cons[cons.length - 1] === 0) cons.pop();
  const level = hvcC[12];
  return [`hvc1`, `${["", "A", "B", "C"][space]}${profile}`, (rev >>> 0).toString(16), `${tier ? "H" : "L"}${level}`, ...cons.map((c) => c.toString(16))].join(".");
}

export function videoCodecOf(tr: Track) {
  const entry = new TextDecoder().decode(tr.stsd.subarray(20, 24));
  if (entry === "hvc1" || entry === "hev1") {
    const hvcC = findBox(tr.stsd, "hvcC")!;
    return { codec: hevcCodec(hvcC), description: hvcC };
  }
  if (entry === "avc1") {
    const avcC = findBox(tr.stsd, "avcC")!;
    const hex = (n: number) => n.toString(16).padStart(2, "0");
    return { codec: `avc1.${hex(avcC[1])}${hex(avcC[2])}${hex(avcC[3])}`, description: avcC };
  }
  throw new Error(`지원하지 않는 코덱: ${entry}`);
}

// avc1 샘플 엔트리 (stsd) 생성
function avc1Stsd(width: number, height: number, avcC: Uint8Array) {
  const entryLen = 8 + 78 + 8 + avcC.length;
  const b = new Uint8Array(16 + entryLen);
  const dv = new DataView(b.buffer);
  const enc = (s: string, p: number) => [...s].forEach((c, i) => (b[p + i] = c.charCodeAt(0)));
  dv.setUint32(0, b.length);
  enc("stsd", 4);
  dv.setUint32(12, 1); // entry_count
  let p = 16;
  dv.setUint32(p, entryLen);
  enc("avc1", p + 4);
  p += 8;
  dv.setUint16(p + 6, 1); // data_reference_index
  dv.setUint16(p + 24, width);
  dv.setUint16(p + 26, height);
  dv.setUint32(p + 28, 0x00480000);
  dv.setUint32(p + 32, 0x00480000);
  dv.setUint16(p + 40, 1); // frame_count
  dv.setUint16(p + 74, 0x0018); // depth
  dv.setInt16(p + 76, -1);
  p += 78;
  dv.setUint32(p, 8 + avcC.length);
  enc("avcC", p + 4);
  b.set(avcC, p + 8);
  return b;
}

// 백그라운드 탭에서도 느려지지 않는 양보: setTimeout 은 탭이 가려지면 1초(길게는 1분)로 늘어나므로 MessageChannel 사용
const chan = typeof MessageChannel !== "undefined" ? new MessageChannel() : null;
const waiters: (() => void)[] = [];
if (chan) {
  chan.port1.onmessage = () => waiters.shift()?.();
  (chan.port1 as any).unref?.(); // Node(테스트)에서 프로세스를 붙잡지 않게
  (chan.port2 as any).unref?.();
}
export const yieldNow = () => new Promise<void>((r) => (chan ? (waiters.push(r), chan.port2.postMessage(0)) : setTimeout(r, 0)));

type Codec = VideoDecoder | VideoEncoder;
const queueOf = (c: Codec) => ("decodeQueueSize" in c ? c.decodeQueueSize : c.encodeQueueSize);
// 코덱 대기열이 max 이하가 될 때까지 기다림 (dequeue 이벤트, 없으면 양보 반복). 오래 줄지 않으면 멈춘 것으로 봄
async function waitQueue(c: Codec, max: number, what: string, timeoutMs = 30_000) {
  const t0 = performance.now();
  while (c.state === "configured" && queueOf(c) > max) {
    await new Promise<void>((r) => {
      const done = () => (c.removeEventListener("dequeue", done), clearTimeout(id), r());
      const id = setTimeout(done, 50);
      c.addEventListener("dequeue", done);
    });
    if (performance.now() - t0 > timeoutMs) throw new Error(`${what} 응답 없음 (${Math.round(timeoutMs / 1000)}초)`);
  }
}

// H.264 레벨: 화면 크기 × 프레임 수에 맞춰 (4K60 은 5.2 필요)
const AVC_LEVELS: [number, number, string][] = [
  [8_912_896, 62_914_560, "28"], // 4.0: 1080p30
  [8_912_896, 133_693_440, "2a"], // 4.2: 1080p60
  [22_282_240, 150_994_944, "32"], // 5.0
  [36_864 * 256, 251_658_240, "33"], // 5.1: 4K30
  [36_864 * 256, 530_841_600, "34"], // 5.2: 4K60
  [139_264 * 256, 1_069_547_520, "3c"], // 6.0
  [139_264 * 256, 4_278_190_080, "3e"], // 6.2
];
export function avcCodecFor(W: number, H: number, fps: number) {
  const fs = W * H, rate = fs * fps;
  const lv = AVC_LEVELS.find(([f, r]) => fs <= f && rate <= r) ?? AVC_LEVELS[AVC_LEVELS.length - 1];
  return `avc1.6400${lv[2]}`;
}
// 화소 수·프레임 수에 비례한 비트레이트 (1080p30 ≈ 20, 4K30 ≈ 37, 4K60 ≈ 75 Mbps)
export const bitrateFor = (W: number, H: number, fps: number) => Math.round(Math.min(120e6, Math.max(20e6, W * H * fps * 0.15)));

// 지원되는 인코더 설정 찾기: 하드웨어 → 소프트웨어, 맞는 레벨 → 높은 레벨
async function pickEncoder(W: number, H: number, fps: number, bitrate: number): Promise<VideoEncoderConfig> {
  const base = codecLevels(avcCodecFor(W, H, fps));
  for (const hw of ["prefer-hardware", "no-preference"] as const)
    for (const codec of base)
      for (const latencyMode of ["quality", "realtime"] as const) {
        const cfg: VideoEncoderConfig = { codec, width: W, height: H, bitrate, framerate: fps, avc: { format: "avc" }, latencyMode, hardwareAcceleration: hw };
        if ((await VideoEncoder.isConfigSupported(cfg).catch(() => ({ supported: false }))).supported) return cfg;
      }
  throw new Error(`이 브라우저에서 ${W}×${H} ${Math.round(fps)}fps H.264 인코딩 불가`);
}
const codecLevels = (first: string) => [first, ...["avc1.640034", "avc1.64003c", "avc1.64003e"].filter((c) => c > first)];
async function pickDecoder(codec: string, description: Uint8Array, W: number, H: number): Promise<VideoDecoderConfig> {
  for (const hw of ["prefer-hardware", "no-preference"] as const) {
    const cfg: VideoDecoderConfig = { codec, description, codedWidth: W, codedHeight: H, hardwareAcceleration: hw };
    if ((await VideoDecoder.isConfigSupported(cfg).catch(() => ({ supported: false }))).supported) return cfg;
  }
  throw new Error(`이 브라우저에서 ${codec} 디코딩 불가 (HEVC 는 하드웨어 디코딩이 되는 Chrome/Edge 필요)`);
}

export interface OverlayOptions {
  tel?: Telemetry | null;
  instruments?: boolean; // 자세계·방위계·수치
  map?: boolean; // 미니맵
  mapsKey?: string;
  goggles?: { segments: GogglesSegment[]; masks: OsdMask[]; view?: "inset" | "full" } | null; // 고글 화면에서 잘라 붙일 영역
  layout?: Layout;
  bitrate?: number;
  onProgress?: (done: number, total: number) => void;
  onStage?: (stage: "tiles" | "render") => void;
  onWarn?: (msg: string) => void; // 멈추지 않고 계속 진행한 문제 (지도 실패, 고글 디코딩 실패, 깨진 프레임 건너뜀)
  signal?: AbortSignal;
  until?: number; // 테스트용: 이 시간(초)까지만
}

export interface GogglesSegment {
  file: Blob;
  offset: number; // 비행 시간 = 고글 시간 + offset
  view?: "inset" | "full"; // 화면 배율 (파일마다 다를 수 있음)
  stat?: StaticMask; // 전체 화면일 때 고정 OSD 통계
}

// 고글 영상에서 요청 시각(단조 증가)의 프레임을 순차 디코드로 공급.
// 고글 파일이 깨졌거나 디코딩에 실패하면 그 파일만 건너뛴다 (드론 영상 렌더는 계속)
class GogglesStream {
  private cur: {
    seg: number; tr: Track; r: Reader; dec: VideoDecoder; next: number; dts: number;
    frames: VideoFrame[]; sync: Set<number> | null; win: Uint8Array; winStart: number; flushed: boolean; last: number; fault: { err: unknown };
  } | null = null;
  private tracks = new Map<number, Track>();
  private bad = new Set<number>();
  seg: GogglesSegment | null = null; // 마지막 frameAt 이 쓴 구간
  private segs: GogglesSegment[];
  private warn: (m: string) => void;
  constructor(segs: GogglesSegment[], warn: (m: string) => void = () => {}) {
    this.segs = segs;
    this.warn = warn;
  }

  async init() {
    for (let i = 0; i < this.segs.length; i++) {
      if (this.tracks.has(i)) continue;
      try {
        this.tracks.set(i, await parse(fileReader(this.segs[i].file)));
      } catch (e) {
        this.fail(i, e);
      }
    }
  }

  private fail(k: number, e: unknown) {
    if (this.bad.has(k)) return;
    this.bad.add(k);
    const name = (this.segs[k].file as File).name ?? `#${k + 1}`;
    this.warn(`고글 영상 ${name} 을 읽지 못해 그 구간은 OSD 없이 진행: ${(e as Error)?.message ?? e}`);
    if (this.cur?.seg === k) this.close();
  }

  private async open(k: number, at: number) {
    this.close();
    const r = fileReader(this.segs[k].file);
    const tr = this.tracks.get(k) ?? (await parse(r));
    this.tracks.set(k, tr);
    const { codec, description } = videoCodecOf(tr);
    const cfg = await pickDecoder(codec, description, tr.width, tr.height);
    const frames: VideoFrame[] = [];
    const fault = { err: null as unknown };
    const dec = new VideoDecoder({ output: (f) => frames.push(f), error: (e) => (fault.err = e) });
    dec.configure(cfg);
    const sync = tr.sync ? new Set(tr.sync) : null;
    let i = 0, dts = 0;
    const target = at * tr.timescale;
    while (i < tr.count - 1 && dts + tr.deltas[i] <= target) dts += tr.deltas[i++];
    while (sync && i > 0 && !sync.has(i + 1)) dts -= tr.deltas[--i];
    this.cur = { seg: k, tr, r, dec, next: i, dts, frames, sync, win: new Uint8Array(), winStart: 0, flushed: false, last: at, fault };
  }

  async frameAt(t: number): Promise<VideoFrame | null> {
    const k = this.segs.findIndex((s, i) => {
      if (this.bad.has(i)) return false;
      const gt = t - s.offset;
      const dur = this.tracks.get(i)?.duration ?? Infinity;
      return gt >= 0 && gt <= dur;
    });
    if (k < 0) return null;
    try {
      return await this.frameIn(k, t);
    } catch (e) {
      this.fail(k, e);
      return null;
    }
  }

  private async frameIn(k: number, t: number): Promise<VideoFrame | null> {
    this.seg = this.segs[k];
    const gt = t - this.segs[k].offset;
    if (!this.cur || this.cur.seg !== k || gt < this.cur.last - 0.5) await this.open(k, gt);
    const c = this.cur!;
    c.last = gt;
    const us = gt * 1e6;
    const t0 = performance.now();
    for (;;) {
      if (c.fault.err) throw c.fault.err;
      if (performance.now() - t0 > 20_000) throw new Error("디코더 응답 없음");
      while (c.frames.length >= 2 && c.frames[1].timestamp <= us) c.frames.shift()!.close();
      const lastF = c.frames[c.frames.length - 1];
      if (lastF && lastF.timestamp >= us) return c.frames[0];
      if (c.next >= c.tr.count) {
        if (!c.flushed) {
          c.flushed = true;
          await c.dec.flush();
          continue;
        }
        return c.frames[c.frames.length - 1] ?? null;
      }
      // 출력이 밀려 있으면 먼저 받아 둔다 (하드웨어 디코더는 프레임 풀이 작음)
      if (c.dec.decodeQueueSize > 4) {
        await waitQueue(c.dec, 4, "고글 디코더", 20_000);
        continue;
      }
      const i = c.next++;
      const off = c.tr.offsets[i], size = c.tr.sizes[i];
      if (off < c.winStart || off + size > c.winStart + c.win.length) {
        c.winStart = off;
        c.win = await c.r.read(off, Math.min(Math.max(8 * 1024 * 1024, size), c.r.size - off));
      }
      c.dec.decode(new EncodedVideoChunk({
        type: !c.sync || c.sync.has(i + 1) ? "key" : "delta",
        timestamp: Math.round(((c.dts + (c.tr.cts?.[i] ?? 0)) / c.tr.timescale) * 1e6),
        data: c.win.subarray(off - c.winStart, off - c.winStart + size),
      }));
      c.dts += c.tr.deltas[i];
      await yieldNow();
    }
  }

  close() {
    if (!this.cur) return;
    this.cur.frames.forEach((f) => f.close());
    this.cur.frames.length = 0;
    if (this.cur.dec.state !== "closed") this.cur.dec.close();
    this.cur = null;
  }
}

const abortError = () => new DOMException("중단됨", "AbortError");

export async function renderOverlay(input: Reader, out: SeekWriter, opts: OverlayOptions = {}) {
  const tr = await parse(input);
  const warn = opts.onWarn ?? (() => {});
  const tel = opts.tel ?? null;
  const track = tel ? buildTrack(tel) : null;
  let tiles: TileSource | null = null;
  if (opts.mapsKey && opts.map !== false && track?.t.length) {
    opts.onStage?.("tiles");
    tiles = new TileSource(opts.mapsKey);
    try {
      await tiles.prefetch(track, 118 * (tr.height / 1080), opts.onProgress);
    } catch (e) {
      tiles = null; // 지도 실패해도 궤적은 그림
      warn(`지도 없이 진행: ${(e as Error)?.message ?? e}`);
    }
  }
  if (opts.signal?.aborted) throw abortError();
  opts.onStage?.("render");
  const W = tr.width;
  const H = tr.height;
  // 첫 프레임 간격은 가끔 튀므로 평균으로
  const fps = tr.count > 1 && tr.duration > 0 ? tr.count / tr.duration : tr.timescale / (tr.deltas[0] || 1001);
  const { codec, description } = videoCodecOf(tr);
  const decCfg = await pickDecoder(codec, description, W, H);
  const encCfg = await pickEncoder(W, H, fps, opts.bitrate ?? bitrateFor(W, H, fps));

  const goggles = opts.goggles?.segments.length && opts.goggles.masks.length ? new GogglesStream(opts.goggles.segments, warn) : null;
  const menu = goggles ? new MenuDetector() : null;
  const osd = goggles ? new OsdCompositor() : null;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d")!;

  const sizes: number[] = [];
  const sync: number[] = [];
  const pts: number[] = [];
  let avcC: Uint8Array | null = null;
  let error: unknown = null;
  let writing = Promise.resolve();
  let pendingBytes = 0; // 아직 디스크에 안 쓴 인코딩 결과 (메모리 폭주 방지)
  let dataSize = 0;
  const queue: VideoFrame[] = [];
  let encoder: VideoEncoder | null = null;
  let decoder: VideoDecoder | null = null;

  try {
    await goggles?.init();
    const ftyp = tr.ftyp;
    await out.write(ftyp);
    const mdatPos = ftyp.length;
    await out.write(new Uint8Array(16)); // mdat 헤더 자리 (마지막에 채움)

    encoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (meta?.decoderConfig?.description && !avcC) avcC = new Uint8Array(meta.decoderConfig.description as ArrayBuffer).slice();
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        sizes.push(data.length);
        pts.push(chunk.timestamp);
        if (chunk.type === "key") sync.push(sizes.length);
        dataSize += data.length;
        pendingBytes += data.length;
        writing = writing.then(
          () => (error ? undefined : out.write(data).then(() => void (pendingBytes -= data.length))),
        ).catch((e) => void (error ??= e));
      },
      error: (e) => (error ??= e),
    });
    encoder.configure(encCfg);
    const enc = encoder;

    // 디코드된 프레임을 순서대로 합성 (고글 프레임을 기다려야 하므로 비동기 처리)
    let frameNo = 0;
    let lastComposed = performance.now();
    const gop = Math.max(1, Math.round(fps * 2));
    const compose = async (frame: VideoFrame) => {
      try {
        const t = frame.timestamp / 1e6;
        ctx.drawImage(frame, 0, 0, W, H);
        if (goggles && opts.goggles) {
          const gf = await goggles.frameAt(t);
          if (gf && menu!.visible(frame, gf, t)) osd!.draw(ctx, gf, opts.goggles.masks, W, H, goggles.seg?.view ?? opts.goggles.view, goggles.seg?.stat);
        }
        const p = tel ? sampleAt(tel, t) : null;
        if (p && (opts.instruments !== false || opts.map !== false)) drawHud(ctx, W, H, p, { t, track, tiles, instruments: opts.instruments !== false, map: opts.map !== false, layout: opts.layout });
        await waitQueue(enc, 6, "인코더");
        while (pendingBytes > 96 * 1024 * 1024 && !error) await new Promise((r) => setTimeout(r, 5)); // 디스크가 느리면 기다림
        const vf = new VideoFrame(canvas, { timestamp: frame.timestamp, duration: frame.duration ?? undefined });
        try {
          enc.encode(vf, { keyFrame: frameNo++ % gop === 0 });
        } finally {
          vf.close();
        }
        lastComposed = performance.now();
      } finally {
        frame.close();
      }
    };
    const drain = async () => {
      while (queue.length) {
        if (error) throw error;
        if (opts.signal?.aborted) throw abortError();
        await compose(queue.shift()!);
      }
    };

    // 디코더: 깨진 프레임에서 오류가 나면 다음 키프레임부터 다시 시작 (최대 5번)
    let decErr: unknown = null;
    const newDecoder = () => {
      const d = new VideoDecoder({ output: (f) => queue.push(f), error: (e) => (decErr = e) });
      d.configure(decCfg);
      return d;
    };
    decoder = newDecoder();
    let resets = 0, skipped = 0;

    const WINDOW = 32 * 1024 * 1024;
    let winStart = 0;
    let win: Uint8Array = new Uint8Array();
    let dts = 0;
    const syncSet = tr.sync ? new Set(tr.sync) : null;
    const isKey = (i: number) => !syncSet || syncSet.has(i + 1);
    const count = opts.until ? Math.min(tr.count, Math.ceil(opts.until * fps)) : tr.count;
    for (let i = 0; i < count; i++) {
      if (error) throw error;
      if (opts.signal?.aborted) throw abortError();
      if (decErr) {
        if (++resets > 5) throw decErr;
        warn(`깨진 프레임을 건너뜀 (${fmtSec(dts / tr.timescale)} 부근): ${(decErr as Error)?.message ?? decErr}`);
        decErr = null;
        if (decoder.state !== "closed") decoder.close();
        decoder = newDecoder();
        while (i < count && !isKey(i)) (dts += tr.deltas[i++]), skipped++;
        if (i >= count) break;
      }
      await drain();
      if (decoder.decodeQueueSize > 6) await waitQueue(decoder, 6, "디코더");
      if (performance.now() - lastComposed > 60_000) throw new Error("렌더가 1분 넘게 멈춤 (디코더/인코더 응답 없음)");
      const off = tr.offsets[i];
      const size = tr.sizes[i];
      if (off < winStart || off + size > winStart + win.length) {
        winStart = off;
        win = await input.read(off, Math.min(Math.max(WINDOW, size), input.size - off));
      }
      const ts = Math.round(((dts + (tr.cts?.[i] ?? 0)) / tr.timescale) * 1e6);
      decoder.decode(
        new EncodedVideoChunk({
          type: isKey(i) ? "key" : "delta",
          timestamp: ts,
          duration: Math.round((tr.deltas[i] / tr.timescale) * 1e6),
          data: win.subarray(off - winStart, off - winStart + size),
        }),
      );
      dts += tr.deltas[i];
      if (i % 30 === 0) opts.onProgress?.(i, count);
      if (i % 8 === 0) await yieldNow();
    }
    await decoder.flush().catch((e) => {
      if (!decErr) throw e;
    });
    await drain();
    goggles?.close();
    await encoder.flush();
    await writing;
    if (error) throw error;
    if (!avcC) throw new Error("인코더 설정(avcC)을 받지 못함");
    if (!sizes.length) throw new Error("출력 프레임이 없음");
    for (let i = 1; i < pts.length; i++) if (pts[i] <= pts[i - 1]) throw new Error("인코더가 B-프레임을 출력함 (미지원)");

    // 출력 트랙: 원본 트랙 메타데이터 재사용 + 새 샘플 테이블
    const deltas = new Uint32Array(sizes.length);
    for (let i = 0; i < sizes.length; i++) {
      const next = i + 1 < pts.length ? pts[i + 1] : pts[i] + (pts[i] - (pts[i - 1] ?? pts[i] - 16683));
      deltas[i] = Math.max(1, Math.round(((next - pts[i]) / 1e6) * tr.timescale));
    }
    const outTrack: Track = {
      ...tr,
      stsd: avc1Stsd(W, H, avcC),
      elstMediaTime: null,
      count: sizes.length,
      offsets: new Float64Array(sizes.length),
      sizes: Uint32Array.from(sizes),
      deltas,
      cts: null,
      sync: Uint32Array.from(sync),
    };
    const moov = buildMoov([outTrack], mdatPos + 16);
    await out.write(moov);
    const hdr = new Uint8Array(16);
    const dv = new DataView(hdr.buffer);
    dv.setUint32(0, 1);
    hdr.set([0x6d, 0x64, 0x61, 0x74], 4); // "mdat"
    dv.setBigUint64(8, BigInt(16 + dataSize));
    await out.writeAt(mdatPos, hdr);
    opts.onProgress?.(tr.count, tr.count);
    return { frames: sizes.length, sourceFrames: count, skipped, size: mdatPos + 16 + dataSize + moov.length };
  } finally {
    // 성공·실패·중단 모두: 프레임과 코덱을 반드시 닫는다 (GPU 메모리·하드웨어 디코더 슬롯)
    queue.splice(0).forEach((f) => f.close());
    goggles?.close();
    if (decoder && decoder.state !== "closed") decoder.close();
    if (encoder && encoder.state !== "closed") encoder.close();
  }
}

const fmtSec = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// 고글 화면의 마스크 영역을 출력의 같은 위치에 붙인다
// 고글 OSD 합성: 사각/원형 마스크 + 가장자리 블러 + 배경 지우기.
// 고글 화면은 출력 프레임 전체로 늘려 같은 정규화 좌표에서 잘라 같은 자리에 붙인다.
// 배경 지우기: 축소 화면 = 검은 여백 제거 / 전체 화면 = 흰 글자+그림자만 떼어 내고 그림자는 새로 그림
export class OsdCompositor {
  private layer: OffscreenCanvas | null = null;
  private lctx: OffscreenCanvasRenderingContext2D | null = null;
  private mask: OffscreenCanvas | null = null;
  private maskKey = "";
  draw(ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, src: CanvasImageSource, masks: OsdMask[], W: number, H: number, view: "inset" | "full" = "inset", stat?: StaticMask) {
    const ms = masks.filter((m) => m.w > 0 && m.h > 0);
    if (!ms.length) return;
    W = Math.round(W);
    H = Math.round(H);
    if (!this.layer || this.layer.width !== W || this.layer.height !== H) {
      this.layer = new OffscreenCanvas(W, H);
      this.lctx = this.layer.getContext("2d", { willReadFrequently: true })!;
      this.mask = new OffscreenCanvas(W, H);
      this.maskKey = "";
    }
    const l = this.lctx!;
    const key = JSON.stringify(ms);
    if (key !== this.maskKey) {
      this.maskKey = key;
      const m = this.mask!.getContext("2d")!;
      m.clearRect(0, 0, W, H);
      for (const b of ms) {
        const f = (b.feather ?? 0) * H;
        m.filter = f > 0.5 ? `blur(${f / 2}px)` : "none";
        m.fillStyle = "#fff";
        m.beginPath();
        if (b.shape === "ellipse") m.ellipse((b.x + b.w / 2) * W, (b.y + b.h / 2) * H, (b.w * W) / 2, (b.h * H) / 2, 0, 0, Math.PI * 2);
        else m.rect(b.x * W, b.y * H, b.w * W, b.h * H);
        m.fill();
      }
      m.filter = "none";
    }
    // 마스크가 덮는 부분만 가져온다 (전체 프레임 복사보다 가벼움)
    l.globalCompositeOperation = "copy";
    l.clearRect(0, 0, W, H);
    l.globalCompositeOperation = "source-over";
    const sw = (src as any).displayWidth ?? (src as any).videoWidth ?? (src as any).width ?? W;
    const sh = (src as any).displayHeight ?? (src as any).videoHeight ?? (src as any).height ?? H;
    const rects = ms.map((b) => {
      const f = (b.feather ?? 0) * H;
      const x0 = Math.max(0, Math.floor(b.x * W - f)), y0 = Math.max(0, Math.floor(b.y * H - f));
      const x1 = Math.min(W, Math.ceil((b.x + b.w) * W + f)), y1 = Math.min(H, Math.ceil((b.y + b.h) * H + f));
      return { b, x0, y0, w: x1 - x0, h: y1 - y0 };
    }).filter((r) => r.w > 0 && r.h > 0);
    for (const r of rects) l.drawImage(src, (r.x0 / W) * sw, (r.y0 / H) * sh, (r.w / W) * sw, (r.h / H) * sh, r.x0, r.y0, r.w, r.h);
    // 키는 마스크 전에: 마스크 밖이 검게 비면 가장자리가 그림자로 오인됨
    for (const r of rects) {
      if (r.b.key === false) continue; // 예전 설정(키 값 없음)도 배경 지우기
      const img = l.getImageData(r.x0, r.y0, r.w, r.h);
      if (view === "full") keyWhite(img, H, stat && { ...stat, x0: r.x0, y0: r.y0, W, H }, { x0: r.x0, y0: r.y0, W, H });
      else keyBlack(img, stat && { ...stat, x0: r.x0, y0: r.y0, W, H });
      l.putImageData(img, r.x0, r.y0);
    }
    l.globalCompositeOperation = "destination-in";
    l.drawImage(this.mask!, 0, 0);
    l.globalCompositeOperation = "source-over";
    ctx.save();
    if (view === "full") {
      // 고글의 옅은 검은 그림자를 새로 그림 (원래 그림자 밑 배경은 가져오지 않음)
      ctx.shadowColor = "rgba(0,0,0,0.75)";
      ctx.shadowBlur = Math.max(1.5, ctx.canvas.height * 0.003);
    }
    ctx.drawImage(this.layer!, 0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
  }
}

// 고글 녹화에는 메뉴·경고 화면도 찍힌다. 고글 화면이 드론 화면과 전혀 다르면 그동안 OSD 를 붙이지 않는다.
// 0.1초마다 32x18 회색으로 비교하고, 0.4초 이상 이어질 때만 상태를 바꿔 깜빡임을 막는다.
export class MenuDetector {
  private cv = new OffscreenCanvas(32, 18);
  private ctx = this.cv.getContext("2d", { willReadFrequently: true })!;
  private last = -1;
  private shown = true;
  private since = 0;
  private gray(src: CanvasImageSource, w: number, h: number) {
    // 위아래 15% 는 OSD 라서 제외
    this.ctx.drawImage(src, 0, h * 0.15, w, h * 0.7, 0, 0, 32, 18);
    const d = this.ctx.getImageData(0, 0, 32, 18).data;
    const g = new Float32Array(576);
    let m = 0;
    for (let i = 0; i < 576; i++) m += g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
    m /= 576;
    let v = 0;
    for (let i = 0; i < 576; i++) v += (g[i] -= m) ** 2;
    const sd = Math.sqrt(v / 576) || 1;
    for (let i = 0; i < 576; i++) g[i] /= sd;
    return g;
  }
  visible(drone: VideoFrame, goggles: VideoFrame, t: number) {
    if (t - this.last < 0.1) return this.shown;
    this.last = t;
    const a = this.gray(drone, drone.displayWidth, drone.displayHeight);
    const b = this.gray(goggles, goggles.displayWidth, goggles.displayHeight);
    let c = 0;
    for (let i = 0; i < 576; i++) c += a[i] * b[i];
    const match = c / 576 > 0.2;
    if (match === this.shown) this.since = t;
    else if (t - this.since >= 0.4) {
      this.shown = match;
      this.since = t;
    }
    return this.shown;
  }
}
