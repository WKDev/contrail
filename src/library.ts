// 폴더 → "비행" 모델. 화면은 이 모델만 보고 그린다.
import { parse } from "./mp4.ts";
import { fileReader } from "./frames.ts";
import { decide, defaultTitle, groupClips, pairKey, parseStart, sortClips, type Clip, type Decision, type Settings } from "./plan.ts";
import { DIRS, RAW_RE, listFiles, subdir, type State, type VideoRecord } from "./store.ts";
import { GOGGLES_RE, inspectGoggles, isRootGoggles, type GogglesInfo } from "./goggles.ts";
import { readFlightLog, RECORD_RE, type FlightLog } from "./flightlog.ts";

export type DirKey = "root" | keyof typeof DIRS;
export interface FileRef {
  dir: DirKey;
  handle: FileSystemFileHandle;
}

export interface Dirs {
  root: FileSystemDirectoryHandle;
  ready: FileSystemDirectoryHandle;
  uploaded: FileSystemDirectoryHandle;
  sources: FileSystemDirectoryHandle;
  excluded: FileSystemDirectoryHandle;
  goggles: FileSystemDirectoryHandle;
  gogglesExt?: FileSystemDirectoryHandle | null; // 따로 지정한 고글 녹화 폴더 (복사하지 않고 그대로 읽음)
  logsExt?: FileSystemDirectoryHandle | null; // 비행기록(DJIFlightRecord_*.txt) 폴더 (선택)
}

export async function openDirs(root: FileSystemDirectoryHandle, gogglesExt?: FileSystemDirectoryHandle | null, logsExt?: FileSystemDirectoryHandle | null): Promise<Dirs> {
  return {
    root,
    gogglesExt,
    logsExt,
    ready: await subdir(root, DIRS.ready),
    uploaded: await subdir(root, DIRS.uploaded),
    sources: await subdir(root, DIRS.sources),
    excluded: await subdir(root, DIRS.excluded),
    goggles: await subdir(root, DIRS.goggles),
  };
}

export interface Index {
  files: Map<string, FileRef>; // 파일명 → 위치 (DJI 원본/결과물)
  sizes: Map<string, number>;
  goggles: GogglesInfo[];
  gogglesExt: "none" | "ok" | "missing"; // 고글 폴더 상태 (missing = SD 카드가 빠졌거나 권한 없음)
  logs: FlightLog[]; // 비행기록 요약 (드론 폴더·FlightRecords 하위 폴더·고글 폴더·비행기록 폴더에서 찾음)
  logsExt: "none" | "ok" | "missing";
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

export async function scanIndex(d: Dirs): Promise<Index> {
  const files = new Map<string, FileRef>();
  const sizes = new Map<string, number>();
  for (const key of ["root", "sources", "excluded", "ready", "uploaded"] as const) {
    for (const [name, handle] of Object.entries(await listFiles(d[key]))) files.set(name, { dir: key, handle });
  }
  const goggles: GogglesInfo[] = [];
  const gogFiles: [string, FileSystemFileHandle, boolean][] = Object.entries(await listFiles(d.goggles)).map(([n, h]) => [n, h, false]);
  const logFiles = new Map<string, FileSystemFileHandle>();
  const add = (name: string, h: FileSystemFileHandle, ext: boolean) => {
    if (RECORD_RE.test(name)) return void (logFiles.has(name) || logFiles.set(name, h));
    if (isRootGoggles(name) && !name.startsWith(".") && !gogFiles.some(([n]) => n === name)) gogFiles.push([name, h, ext]);
  };
  for (const [name, handle] of Object.entries(await listFiles(d.root))) add(name, handle, false);
  // SD 카드의 DCIM/100MEDIA 처럼 몇 단계 아래에 있어도 찾는다
  const walk = async (h: FileSystemDirectoryHandle, depth: number, ext: boolean) => {
    for await (const [name, e] of (h as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
      if (e.kind === "directory" && depth < 3 && !name.startsWith(".") && !name.startsWith("_")) await walk(e as FileSystemDirectoryHandle, depth + 1, ext);
      else if (e.kind === "file") add(name, e as FileSystemFileHandle, ext);
    }
  };
  let gogglesExt: Index["gogglesExt"] = d.gogglesExt ? "ok" : "none";
  if (d.gogglesExt) await walk(d.gogglesExt, 0, true).catch(() => void (gogglesExt = "missing"));
  // 드론 폴더 안의 FlightRecords 폴더 (기체·고글에서 통째로 복사해 온 경우)
  try {
    await walk(await d.root.getDirectoryHandle("FlightRecords"), 2, false);
  } catch {}
  let logsExt: Index["logsExt"] = d.logsExt ? "ok" : "none";
  if (d.logsExt) await walk(d.logsExt, 0, false).catch(() => void (logsExt = "missing"));
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
  return { files, sizes, goggles, gogglesExt, logs, logsExt };
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
  youtubeId?: string;
  overlayYoutubeId?: string;
}

export interface Library {
  flights: Flight[];
  pendingClips: Clip[]; // 루트의 모든 원본 (제외 포함)
  decisions: Decision[];
  excluded: { name: string; dir: DirKey; duration?: number; reason: string }[];
}

const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const stemOf = (name: string) => name.replace(/\.(mp4|lrf|srt)$/i, "");

export async function buildLibrary(idx: Index, st: State, s: Settings): Promise<Library> {
  // 1) 루트의 원본 = 병합 대기
  const raw: Clip[] = [];
  for (const [name, ref] of idx.files) {
    const m = RAW_RE.exec(name);
    if (!m || ref.dir !== "root" || m[2].toUpperCase() !== "MP4") continue;
    try {
      const f = await ref.handle.getFile();
      const info = await mediaInfo(f);
      raw.push({ name, stem: m[1], start: parseStart(name)!, duration: info.duration, size: f.size });
    } catch {}
  }
  const clips = sortClips(raw);
  const decisions = decide(clips, st.scores, st.overrides, s);
  const remote = st.remote ?? {};
  decisions.forEach((d, i) => {
    if (i && d.mergePrev && remote[clips[i].name] !== remote[clips[i - 1].name]) {
      d.mergePrev = false;
      d.mergeReason = "이미 따로 업로드됨";
    }
  });
  const flights: Flight[] = [];
  const idxOf = new Map(clips.map((c, i) => [c.name, i]));
  for (const g of groupClips(clips, decisions)) {
    const joins: Join[] = g.slice(1).map((c) => {
      const d = decisions[idxOf.get(c.name)!];
      return { reason: d.overridden ? "manual" : d.mergeReason === "DJI 자동분할" ? "auto" : "scene", score: d.score, gap: d.gap };
    });
    const duration = g.reduce((a, c) => a + c.duration, 0);
    flights.push({
      id: g[0].stem, number: 0, day: dayKey(g[0].start), start: g[0].start, end: g[0].start + (g[g.length - 1].start - g[0].start) + g[g.length - 1].duration * 1000,
      duration, size: g.reduce((a, c) => a + c.size, 0), clips: g, joins, status: "pending",
      youtubeId: g.every((c) => remote[c.name] && remote[c.name] === remote[g[0].name]) ? remote[g[0].name] : undefined,
    });
  }

  // 2) 기록된 결과물 = 완성된 비행
  const overlays = Object.entries(st.videos).filter(([, v]) => v.variant === "hud");
  const gogOuts = Object.entries(st.videos).filter(([, v]) => v.variant === "goggles");
  for (const [name, rec] of Object.entries(st.videos)) {
    if (rec.variant) continue;
    const id = stemOf(rec.sources[0]);
    if (flights.some((f) => f.id === id)) continue; // 아직 루트에 원본이 있으면 대기로 취급
    const durs = rec.clipDurations ?? (await sourceDurations(idx, rec));
    const cs: Clip[] = rec.sources.map((src, i) => ({
      name: src, stem: stemOf(src), start: parseStart(src) ?? rec.start, duration: durs[i] ?? rec.duration / rec.sources.length, size: idx.sizes.get(src) ?? 0,
    }));
    const ov = overlays.find(([, v]) => v.sources.join() === rec.sources.join());
    const go = gogOuts.find(([, v]) => v.sources.join() === rec.sources.join());
    flights.push({
      id, number: 0, day: dayKey(rec.start), start: rec.start, end: rec.start + rec.duration * 1000, duration: rec.duration,
      size: idx.sizes.get(name) ?? cs.reduce((a, c) => a + c.size, 0), clips: cs,
      joins: cs.slice(1).map((c, i) => ({ reason: rec.joinReasons?.[i] ?? "auto", gap: (c.start - cs[i].start) / 1000 - cs[i].duration })),
      status: "done", record: rec, output: { name, ref: idx.files.get(name) },
      overlay: ov ? { name: ov[0], ref: idx.files.get(ov[0]), record: ov[1] } : undefined,
      gogglesOut: go ? { name: go[0], ref: idx.files.get(go[0]), record: go[1] } : undefined,
      youtubeId: rec.youtubeId, overlayYoutubeId: ov?.[1].youtubeId,
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
    if (decisions[i].excluded) excluded.push({ name: c.name, dir: "root", duration: c.duration, reason: decisions[i].excludeReason });
  });
  for (const [name, ref] of idx.files) if (ref.dir === "excluded" && /\.mp4$/i.test(name)) excluded.push({ name, dir: "excluded", reason: "" });

  return { flights, pendingClips: clips, decisions, excluded };
}

async function sourceDurations(idx: Index, rec: VideoRecord) {
  const out: number[] = [];
  for (const src of rec.sources) {
    const ref = idx.files.get(src);
    if (!ref) return [];
    try {
      out.push((await mediaInfo(await ref.handle.getFile())).duration);
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
