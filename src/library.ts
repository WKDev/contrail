// 폴더 → "비행" 모델. 화면은 이 모델만 보고 그린다.
import { parse } from "./mp4.ts";
import { fileReader } from "./frames.ts";
import { decide, defaultTitle, groupClips, pairKey, parseStart, sortClips, type Clip, type Decision, type Override, type Settings } from "./plan.ts";
import { RAW_RE, listFiles, type State, type VideoRecord } from "./store.ts";
import type { ProjectDirs } from "./roles.ts";
import { GOGGLES_RE, inspectGoggles, isRootGoggles, type GogglesInfo } from "./goggles.ts";
import { readFlightLog, RECORD_RE, type FlightLog } from "./flightlog.ts";

export type DirKey = "raw" | "excluded" | "merged" | "gmerged" | "hud" | "legacy";
export interface FileRef {
  dir: DirKey;
  handle: FileSystemFileHandle;
}

// 역할별 폴더 (roles.ts). 원본(droneRaw·gogglesRaw·logs·legacy·excluded)은 읽기만
export type Dirs = ProjectDirs;

export interface Index {
  files: Map<string, FileRef>; // 파일명 → 위치 (DJI 원본/결과물)
  sizes: Map<string, number>;
  goggles: GogglesInfo[];
  gogglesState: "none" | "ok" | "missing"; // 고글 원본 폴더 상태 (missing = SD 카드가 빠졌거나 권한 없음)
  logs: FlightLog[]; // 비행기록 요약 (드론 원본·FlightRecords 하위 폴더·고글 원본·비행기록 폴더에서 찾음)
  logsState: "none" | "ok" | "missing";
}

// 메타데이터(길이) 캐시: 같은 파일을 매번 다시 파싱하지 않도록
const durCache = new Map<string, { duration: number; frames: number }>();
const gogCache = new Map<string, GogglesInfo>();
const logCache = new Map<string, FlightLog | null>();

export async function mediaInfo(f: File) {
  const key = `${f.name}:${f.size}:${f.lastModified}`;
  let v = durCache.get(key);
  if (!v) {
    const tr = await parse(fileReader(f));
    v = { duration: tr.duration, frames: tr.count };
    durCache.set(key, v);
  }
  return v;
}

// 같은 폴더가 여러 역할이면 (예전 구조의 2_ready = 결과 3종, 드론 원본 = 프로젝트 폴더) 한 번만 읽는다
async function uniqueDirs<T>(list: [T, FileSystemDirectoryHandle | null][]) {
  const out: [T, FileSystemDirectoryHandle][] = [];
  for (const [k, h] of list) {
    if (!h) continue;
    let dup = false;
    for (const [, o] of out) if (o === h || (await o.isSameEntry(h).catch(() => false))) dup = true;
    if (!dup) out.push([k, h]);
  }
  return out;
}

export async function scanIndex(d: Dirs): Promise<Index> {
  const files = new Map<string, FileRef>();
  const sizes = new Map<string, number>();
  const where = await uniqueDirs<DirKey>([
    ["raw", d.droneRaw], ["merged", d.droneMerged], ["gmerged", d.gogglesMerged], ["hud", d.hud],
    ...d.legacy.map((h) => ["legacy", h] as [DirKey, FileSystemDirectoryHandle]), ["excluded", d.excluded],
  ]);
  for (const [key, dir] of where) {
    for (const [name, handle] of Object.entries(await listFiles(dir))) if (!files.has(name)) files.set(name, { dir: key, handle });
  }
  const goggles: GogglesInfo[] = [];
  const gogFiles: [string, FileSystemFileHandle, boolean][] = [];
  const logFiles = new Map<string, FileSystemFileHandle>();
  const add = (name: string, h: FileSystemFileHandle, ext: boolean) => {
    if (RECORD_RE.test(name)) return void (logFiles.has(name) || logFiles.set(name, h));
    if (isRootGoggles(name) && !name.startsWith(".") && !gogFiles.some(([n]) => n === name)) gogFiles.push([name, h, ext]);
  };
  // SD 카드의 DCIM/100MEDIA 처럼 몇 단계 아래에 있어도 찾는다
  const walk = async (h: FileSystemDirectoryHandle, depth: number, ext: boolean) => {
    for await (const [name, e] of (h as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
      if (e.kind === "directory" && depth < 3 && !name.startsWith(".") && !name.startsWith("_")) await walk(e as FileSystemDirectoryHandle, depth + 1, ext);
      else if (e.kind === "file") add(name, e as FileSystemFileHandle, ext);
    }
  };
  // 고글 원본 우선, 그다음 예전 goggles/ 폴더, 드론 원본 맨 위에 넣은 고글 파일
  let gogglesState: Index["gogglesState"] = d.gogglesRaw ? "ok" : "none";
  if (d.gogglesRaw) await walk(d.gogglesRaw, 0, true).catch(() => void (gogglesState = "missing"));
  if (d.gogglesExtra) await walk(d.gogglesExtra, 2, false).catch(() => {});
  for (const [name, handle] of Object.entries(await listFiles(d.droneRaw).catch(() => ({})))) add(name, handle, false);
  // 드론 원본 안의 FlightRecords 폴더 (기체·고글에서 통째로 복사해 온 경우)
  try {
    await walk(await d.droneRaw.getDirectoryHandle("FlightRecords"), 2, false);
  } catch {}
  let logsState: Index["logsState"] = d.logs ? "ok" : "none";
  if (d.logs) await walk(d.logs, 0, false).catch(() => void (logsState = "missing"));
  const logs: FlightLog[] = [];
  for (const [name, h] of logFiles) {
    const f = await h.getFile().catch(() => null);
    if (!f) continue;
    const key = `${name}:${f.size}:${f.lastModified}`;
    if (!logCache.has(key)) logCache.set(key, await readFlightLog(f).catch(() => null));
    const l = logCache.get(key);
    if (l && l.duration > 0) logs.push(l);
  }
  logs.sort((a, b) => a.start - b.start);
  for (const [name, handle, ext] of gogFiles) {
    if (!GOGGLES_RE.test(name)) continue;
    const f = await handle.getFile().catch(() => null);
    if (!f) continue;
    const key = `${name}:${f.size}:${f.lastModified}`;
    try {
      let g = gogCache.get(key);
      if (!g) gogCache.set(key, (g = await inspectGoggles(f)));
      goggles.push({ ...g, file: f, linked: ext });
    } catch {}
  }
  for (const [name, ref] of files) if (/\.mp4$/i.test(name)) sizes.set(name, (await ref.handle.getFile()).size);
  return { files, sizes, goggles, gogglesState, logs, logsState };
}

export type FlightStatus = "pending" | "done";

export interface Join {
  reason: "auto" | "scene" | "manual";
  score?: number;
  gap: number | null;
}

export interface Flight {
  id: string; // 첫 클립 stem
  number: number; // 그 날의 n번째 비행
  day: string; // YYYY-MM-DD
  start: number;
  end: number;
  duration: number;
  size: number;
  clips: Clip[];
  joins: Join[]; // clips.length - 1
  status: FlightStatus;
  record?: VideoRecord;
  output?: { name: string; ref?: FileRef }; // 병합(또는 단일) 결과
  overlay?: { name: string; ref?: FileRef; record: VideoRecord };
  gogglesOut?: { name: string; ref?: FileRef; record: VideoRecord }; // 고글 녹화 병합본
  missing?: boolean; // 기록은 있는데 결과 파일도 원본 MP4 도 없음
  synthetic?: boolean; // 클립 하나짜리: 원본이 곧 결과, 기록은 아직 저장 전
  youtubeId?: string;
  overlayYoutubeId?: string;
}

export interface Library {
  flights: Flight[];
  pendingClips: Clip[]; // 루트의 모든 원본 (제외 포함)
  decisions: Decision[];
  excluded: { name: string; dir: DirKey; duration?: number; reason: string }[];
  adopt: { name: string; rec: VideoRecord }[]; // 기록 없이 발견한 병합본 (프레임 수 확인됨) → 상태에 저장할 것
}

const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const stemOf = (name: string) => name.replace(/\.(mp4|lrf|srt)$/i, "");

type Info = (f: File) => Promise<{ duration: number; frames: number }>;
const RAW_DIRS: DirKey[] = ["raw", "excluded"]; // 병합 대기가 될 수 있는 원본 위치
const ORIG_DIRS: DirKey[] = ["raw", "excluded", "legacy"]; // 원본을 찾는 위치

export async function buildLibrary(idx: Index, st: State, s: Settings, info: Info = mediaInfo): Promise<Library> {
  const remote = st.remote ?? {};
  const overlays = Object.entries(st.videos).filter(([, v]) => v.variant === "hud");
  const gogOuts = Object.entries(st.videos).filter(([, v]) => v.variant === "goggles");
  const isOrig = (n: string) => ORIG_DIRS.includes(idx.files.get(n)?.dir as DirKey);
  const flights: Flight[] = [];
  const adopt: Library["adopt"] = [];

  // 결과물(기록)이 있는 비행. ref 없음 = 결과 파일이 사라짐
  const doneFlight = async (name: string, rec: VideoRecord, extra: Partial<Flight> = {}): Promise<Flight> => {
    const id = stemOf(rec.sources[0]);
    const durs = rec.clipDurations ?? (await sourceDurations(idx, rec, info));
    const cs: Clip[] = rec.sources.map((src, i) => ({
      name: src, stem: stemOf(src), start: parseStart(src) ?? rec.start, duration: durs[i] ?? rec.duration / rec.sources.length, size: idx.sizes.get(src) ?? 0,
    }));
    const ov = overlays.find(([, v]) => v.sources.join() === rec.sources.join());
    const go = gogOuts.find(([, v]) => v.sources.join() === rec.sources.join());
    return {
      id, number: 0, day: dayKey(rec.start), start: rec.start, end: rec.start + rec.duration * 1000, duration: rec.duration,
      size: idx.sizes.get(name) ?? cs.reduce((a, c) => a + c.size, 0), clips: cs,
      joins: cs.slice(1).map((c, i) => ({ reason: rec.joinReasons?.[i] ?? "auto", gap: (c.start - cs[i].start) / 1000 - cs[i].duration })),
      status: "done", record: rec, output: { name, ref: idx.files.get(name) },
      overlay: ov ? { name: ov[0], ref: idx.files.get(ov[0]), record: ov[1] } : undefined,
      gogglesOut: go ? { name: go[0], ref: idx.files.get(go[0]), record: go[1] } : undefined,
      youtubeId: rec.youtubeId, overlayYoutubeId: ov?.[1].youtubeId,
      ...extra,
    };
  };

  // 1) 기록된 결과물: 결과 파일이 있으면 완료 (원본이 남아 있어도). 없으면 원본이 다 있으면 대기로, 아니면 "파일 없음"
  const used = new Set<string>();
  for (const [name, rec] of Object.entries(st.videos)) {
    if (rec.variant) continue;
    const ref = idx.files.get(name);
    const present = !!ref && (!ORIG_DIRS.includes(ref.dir) || rec.sources.length === 1);
    if (!present && rec.sources.every(isOrig)) continue;
    rec.sources.forEach((x) => used.add(x));
    flights.push(await doneFlight(name, rec, present ? {} : { missing: true }));
  }

  // 2) 아직 결과가 없는 원본 = 병합 대기. 예전 _excluded 의 원본은 기본 제외
  const raw: Clip[] = [];
  const overrides: Record<string, Override> = { ...st.overrides };
  for (const [name, ref] of idx.files) {
    const m = RAW_RE.exec(name);
    if (!m || !RAW_DIRS.includes(ref.dir) || m[2].toUpperCase() !== "MP4" || used.has(name)) continue;
    try {
      const f = await ref.handle.getFile();
      const meta = await info(f);
      raw.push({ name, stem: m[1], start: parseStart(name)!, duration: meta.duration, size: f.size });
      if (ref.dir === "excluded") overrides[name] = { ...overrides[name], excluded: overrides[name]?.excluded ?? true };
    } catch {}
  }
  const clips = sortClips(raw);
  const decisions = decide(clips, st.scores, overrides, s);
  decisions.forEach((d, i) => {
    if (i && d.mergePrev && remote[clips[i].name] !== remote[clips[i - 1].name]) {
      d.mergePrev = false;
      d.mergeReason = "이미 따로 업로드됨";
    }
  });
  const idxOf = new Map(clips.map((c, i) => [c.name, i]));
  for (const g of groupClips(clips, decisions)) {
    const joins: Join[] = g.slice(1).map((c) => {
      const d = decisions[idxOf.get(c.name)!];
      return { reason: d.overridden ? "manual" : d.mergeReason === "DJI 자동분할" ? "auto" : "scene", score: d.score, gap: d.gap };
    });
    const duration = g.reduce((a, c) => a + c.duration, 0);
    const base: VideoRecord = {
      sources: g.map((c) => c.name), title: defaultTitle(g[0].start), start: g[0].start, duration,
      clipDurations: g.map((c) => c.duration), joinReasons: joins.map((j) => j.reason),
    };
    // 클립 하나 = 병합할 것 없음: 원본이 곧 결과
    if (g.length === 1) {
      flights.push(await doneFlight(g[0].name, base, { synthetic: true }));
      continue;
    }
    // 기록 없이 병합본만 있으면: 프레임 수가 원본 합과 같을 때만 받아들임 (다시 병합해 중복을 만들지 않게)
    const mergedName = `${g[0].stem}_merged.MP4`;
    const mref = idx.files.get(mergedName);
    if (mref && !ORIG_DIRS.includes(mref.dir) && !st.videos[mergedName]) {
      try {
        const out = await info(await mref.handle.getFile());
        let sum = 0;
        for (const c of g) sum += (await info(await idx.files.get(c.name)!.handle.getFile())).frames;
        if (out.frames === sum) {
          const rec: VideoRecord = { ...base, duration: out.duration, verified: { frames: out.frames, sourceFrames: sum, duration: out.duration } };
          adopt.push({ name: mergedName, rec });
          flights.push(await doneFlight(mergedName, rec));
          continue;
        }
      } catch {}
    }
    flights.push({
      id: g[0].stem, number: 0, day: dayKey(g[0].start), start: g[0].start, end: g[0].start + (g[g.length - 1].start - g[0].start) + g[g.length - 1].duration * 1000,
      duration, size: g.reduce((a, c) => a + c.size, 0), clips: g, joins, status: "pending",
      youtubeId: g.every((c) => remote[c.name] && remote[c.name] === remote[g[0].name]) ? remote[g[0].name] : undefined,
    });
  }

  // 날짜별 번호
  flights.sort((a, b) => a.start - b.start);
  const perDay = new Map<string, number>();
  for (const f of flights) {
    const n = (perDay.get(f.day) ?? 0) + 1;
    perDay.set(f.day, n);
    f.number = n;
  }

  const excluded: Library["excluded"] = [];
  clips.forEach((c, i) => {
    if (decisions[i].excluded) excluded.push({ name: c.name, dir: idx.files.get(c.name)!.dir, duration: c.duration, reason: decisions[i].excludeReason });
  });

  return { flights, pendingClips: clips, decisions, excluded, adopt };
}

async function sourceDurations(idx: Index, rec: VideoRecord, info: Info) {
  const out: number[] = [];
  for (const src of rec.sources) {
    const ref = idx.files.get(src);
    if (!ref) return [];
    try {
      out.push((await info(await ref.handle.getFile())).duration);
    } catch {
      return [];
    }
  }
  return out;
}

// 썸네일/프레임용 파일: LRF 프록시 우선
export function proxyRef(idx: Index, stem: string): FileRef | undefined {
  return idx.files.get(`${stem}.LRF`) ?? idx.files.get(`${stem}.lrf`) ?? idx.files.get(`${stem}.MP4`) ?? idx.files.get(`${stem}.mp4`);
}

export const flightTitle = (f: Flight, st: State, tf: (n: number) => string) => st.prefs?.[f.id]?.title || f.record?.title?.replace(/^DJI \d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/, "") || tf(f.number);
export const recordTitle = (f: Flight, name: string) => name || defaultTitle(f.start);
export { pairKey };
