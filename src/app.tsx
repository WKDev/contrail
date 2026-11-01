// 앱 컨트롤러: 폴더/상태/작업을 관리하고 화면 컴포넌트에 컨텍스트로 넘긴다.
import { matchLog, type FlightLog } from "./flightlog.ts";
import { createContext } from "preact";
import { useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { merge, parse } from "./mp4.ts";
import { fileReader, frameImage } from "./frames.ts";
import { grayFrame } from "./media.ts";
import { continuity } from "./sim.ts";
import { DEFAULT_SETTINGS, defaultTitle, pairKey, type Settings } from "./plan.ts";
import {
  defaultPrefs, emptyState, ensurePermission, exists, flushState, loadGogglesDir, loadLogsDir, loadRoot, saveLogsDir, moveFile, saveGogglesDir, readState, saveRoot, telemetryFile, writeState,
  layoutOf, linksOf, type FlightPrefs, type GogglesLink, type Layout, type State, type VideoRecord,
} from "./store.ts";
import { buildLibrary, flightTitle, mediaInfo, openDirs, proxyRef, scanIndex, type Dirs, type Flight, type Index, type Library } from "./library.ts";
import { concatTelemetry, fromJSON, readTelemetry, toJSON, type Telemetry } from "./telemetry.ts";
import { renderOverlay } from "./render.ts";
import { analyzeGoggles } from "./osdstat.ts";
import { inspectGoggles, isRootGoggles, matchGogglesForClips, syncGoggles, type GogglesInfo } from "./goggles.ts";
import * as yt from "./youtube.ts";
import { fmtDayShort, t, useLang } from "./i18n.ts";
import { Shell } from "./ui/Shell.tsx";

// ---------- 설정 (브라우저 localStorage) ----------
export interface Config extends Settings {
  mapsKey: string;
  youtube: boolean;
  clientId: string;
  playlist: string;
  privacy: "private" | "unlisted" | "public";
  dailyQuota: number;
  videoCost: number;
}
const CONFIG_KEY = "dji-uploader-config";
export const defaultConfig: Config = {
  ...DEFAULT_SETTINGS,
  mapsKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? "",
  youtube: !!import.meta.env.VITE_GOOGLE_CLIENT_ID,
  clientId: import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "",
  playlist: import.meta.env.VITE_YOUTUBE_PLAYLIST ?? "",
  privacy: "unlisted",
  dailyQuota: 10000,
  videoCost: yt.COST.videoInsert,
};
function loadConfig(): Config {
  try {
    const c = { ...defaultConfig, ...JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "{}") };
    for (const k of ["clientId", "mapsKey", "playlist"] as const) c[k] ||= defaultConfig[k];
    c.autoSplitSimMax = DEFAULT_SETTINGS.autoSplitSimMax;
    return c;
  } catch {
    return defaultConfig;
  }
}
const quotaDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());

// ---------- 작업 상태 ----------
export type Phase = "merge" | "verify" | "tiles" | "render" | "goggles" | "gmerge" | "upload" | "copy" | "scanGoggles" | "autoSync";
export interface Job {
  flightId?: string;
  phase: Phase;
  done: number;
  total: number;
  started: number;
  label?: string;
}
export interface LogEntry {
  t: number;
  msg: string;
  err?: boolean;
}
export type View = "all" | "pending" | "done" | "goggles" | "excluded" | "upload";

export interface AppCtx {
  config: Config;
  saveConfig: (c: Config) => void;
  dirs: Dirs | null;
  savedRoot: FileSystemDirectoryHandle | null;
  savedGoggles: FileSystemDirectoryHandle | null;
  logOf: (f: Flight) => FlightLog | null;
  linkLogsFolder: () => Promise<void>;
  idx: Index | null;
  lib: Library | null;
  state: State;
  view: View;
  setView: (v: View) => void;
  day: string | null;
  setDay: (d: string | null) => void;
  query: string;
  setQuery: (q: string) => void;
  sortNew: boolean;
  setSortNew: (b: boolean) => void;
  selected: Flight | null;
  select: (id: string | null) => void;
  job: Job | null;
  batch: { i: number; n: number; label: string } | null;
  batchTodo: () => { f: Flight; overlay: boolean }[];
  runAll: () => Promise<void>;
  log: LogEntry[];
  loading: boolean;
  account: string | null;
  showSettings: boolean;
  setShowSettings: (b: boolean) => void;
  openFolder: (h?: FileSystemDirectoryHandle, goggles?: FileSystemDirectoryHandle | null) => Promise<void>;
  pickDir: (kind: "drone" | "goggles") => Promise<FileSystemDirectoryHandle | null>;
  setGogglesFolder: (h: FileSystemDirectoryHandle | null) => Promise<void>;
  reconnectGoggles: () => Promise<void>;
  linkGogglesFolder: () => Promise<void>;
  refresh: () => Promise<void>;
  setOverride: (name: string, key: "excluded" | "mergePrev", v: boolean | undefined) => void;
  prefsOf: (id: string) => FlightPrefs;
  setPrefs: (id: string, patch: Partial<FlightPrefs>) => void;
  run: (f: Flight, what: { merge: boolean; overlay: boolean; goggles?: boolean }) => Promise<void>;
  gogglesMergeNeeded: (f: Flight) => boolean;
  setGogglesView: (f: Flight, file: string, view: "inset" | "full", manual: boolean) => void;
  cancel: () => void;
  thumb: (stem: string) => string | undefined;
  seam: (a: Flight["clips"][number], b: Flight["clips"][number]) => Promise<[string, string]>;
  telemetryOf: (f: Flight) => Promise<Telemetry | null>;
  previewFile: (f: Flight) => Promise<{ file: File; kind: "overlay" | "output" | "proxy" } | null>;
  gogglesOf: (f: Flight) => { links: { link: GogglesLink; info: GogglesInfo | null }[]; candidates: GogglesInfo[] };
  syncGogglesFor: (f: Flight, list: GogglesInfo[]) => Promise<void>;
  nudgeGoggles: (f: Flight, file: string, delta: number) => void;
  unlinkGoggles: (f: Flight) => void;
  layout: Layout;
  setLayout: (l: Layout | null) => void;
  addGoggles: (from?: "folder" | "files") => Promise<void>;
  tidyExcluded: () => Promise<void>;
  restoreExcluded: (name: string) => Promise<void>;
  ytLogin: () => Promise<void>;
  ytSync: () => Promise<void>;
  ytUpload: (items: { flight: Flight; overlay: boolean }[]) => Promise<void>;
  quotaLeft: () => number;
  perUpload: number;
}

const Ctx = createContext<AppCtx>(null as unknown as AppCtx);
export const useApp = () => useContext(Ctx);

export function App() {
  useLang();
  const [config, setConfigRaw] = useState(loadConfig);
  const [dirs, setDirs] = useState<Dirs | null>(null);
  const [savedRoot, setSavedRoot] = useState<FileSystemDirectoryHandle | null>(null);
  const [savedGoggles, setSavedGoggles] = useState<FileSystemDirectoryHandle | null>(null);
  const [batch, setBatch] = useState<{ i: number; n: number; label: string } | null>(null);
  const savedLogs = useRef<FileSystemDirectoryHandle | null>(null);
  const [idx, setIdx] = useState<Index | null>(null);
  const [lib, setLib] = useState<Library | null>(null);
  const [state, setStateRaw] = useState<State>(emptyState);
  const stateRef = useRef(state);
  const dirsRef = useRef<Dirs | null>(null);
  const [view, setView] = useState<View>("all");
  const [day, setDay] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sortNew, setSortNew] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [account, setAccount] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const abortRef = useRef<AbortController | null>(null);
  const playlistRef = useRef<string | null>(null);
  const seamCache = useRef(new Map<string, Promise<[string, string]>>());
  const telCache = useRef(new Map<string, Promise<Telemetry | null>>());
  const idxRef = useRef<Index | null>(null);
  idxRef.current = idx;

  const say = (msg: string, err = false) => {
    if (err) console.error(msg);
    setLog((l) => [{ t: Date.now(), msg, err }, ...l].slice(0, 300));
  };

  const saveConfig = (c: Config) => {
    setConfigRaw(c);
    playlistRef.current = null;
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(c));
    } catch {}
  };

  const update = (fn: (s: State) => void) => {
    const next: State = structuredClone(stateRef.current);
    if (next.quota.day !== quotaDay()) next.quota = { day: quotaDay(), used: 0 };
    fn(next);
    stateRef.current = next;
    setStateRaw(next);
    if (dirsRef.current) writeState(dirsRef.current.root, next).catch((e) => say(`state: ${e}`, true));
    return next;
  };

  useEffect(() => {
    loadRoot().then((h) => h && setSavedRoot(h));
    loadGogglesDir().then((h) => h && setSavedGoggles(h));
    loadLogsDir().then((h) => h && (savedLogs.current = h));
    // 개발용: ?opfs → 브라우저 내부 저장소(OPFS)를 폴더로 열기 (헤드리스 검증용, 배포 빌드에서 제거됨)
    if (import.meta.env.DEV && new URLSearchParams(location.search).has("opfs")) {
      const gog = new URLSearchParams(location.search).get("gog"); // ?opfs&gog=a/b → OPFS 하위 폴더를 고글 폴더로
      navigator.storage.getDirectory().then(async (h) => {
        let g: FileSystemDirectoryHandle | null = null;
        if (gog) for (const part of gog.split("/")) g = await (g ?? h).getDirectoryHandle(part, { create: true });
        openFolder(h, g);
      });
    }
  }, []);

  // 작업 중: 화면 꺼짐(절전) 막기 + 페이지 닫기 전에 경고
  useEffect(() => {
    if (!job) return;
    let lock: any = null;
    let alive = true;
    const acquire = () =>
      (navigator as any).wakeLock?.request("screen").then((l: any) => (alive ? (lock = l) : l.release())).catch(() => {});
    acquire();
    const onVis = () => document.visibilityState === "visible" && (!lock || lock.released) && acquire(); // 탭을 가리면 풀리므로 돌아오면 다시
    const onLeave = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = t("run.leaveWarn");
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      alive = false;
      lock?.release().catch(() => {});
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("beforeunload", onLeave);
    };
  }, [!!job]);

  // ---------- 스캔 ----------
  // reload: 폴더를 새로 열 때만 상태 파일을 디스크에서 읽는다. 그 외에는 메모리 상태가 최신
  // (작업 직후 다시 읽으면 아직 저장 중인 기록을 이전 내용으로 덮어쓰게 됨)
  async function scan(d = dirsRef.current, quiet = false, reload = false) {
    if (!d) return;
    if (!quiet) setLoading(true);
    try {
      await flushState();
      let st = stateRef.current;
      if (reload) {
        st = await readState(d.root);
        if (st.quota.day !== quotaDay()) st.quota = { day: quotaDay(), used: 0 };
        stateRef.current = st;
        setStateRaw(st);
      }
      // 지난번에 브라우저가 꺼지는 등으로 남은 임시 파일 정리 (작업 중이 아닐 때만)
      if (reload && !abortRef.current)
        for await (const [name] of (d.ready as any).entries() as AsyncIterable<[string]>)
          if (name.endsWith(".part")) await d.ready.removeEntry(name).catch(() => {});
      const ix = await scanIndex(d);
      setIdx(ix);
      setLib(await buildLibrary(ix, st, config));
    } catch (e) {
      say(String(e), true);
    } finally {
      setLoading(false);
    }
  }

  // 판단 기준·수동 선택이 바뀌면 묶음을 다시 계산 (파일 재스캔 없이)
  useEffect(() => {
    if (idx) buildLibrary(idx, state, config).then(setLib);
  }, [state.overrides, state.scores, state.videos, state.remote, config.minDuration, config.maxGap, config.simMax]);

  // 폴더 고르기 창. 닫으면 null
  async function pickDir(kind: "drone" | "goggles") {
    try {
      return (await (window as any).showDirectoryPicker(kind === "drone" ? { id: "dji", mode: "readwrite" } : { id: "goggles-sd", mode: "read" })) as FileSystemDirectoryHandle;
    } catch (e) {
      if ((e as Error).name !== "AbortError") say(String(e), true);
      return null;
    }
  }

  // 고글 폴더 권한: 거절되거나 SD 카드가 빠져 있어도 드론 폴더는 열리게 한다 (사이드바에서 다시 연결)
  const gogglesAccess = (h: FileSystemDirectoryHandle | null | undefined) => (h ? ensurePermission(h, "read").catch(() => false) : Promise.resolve(false));

  // goggles: undefined = 기억해 둔 고글 폴더 그대로, null = 고글 폴더 없음
  async function openFolder(h?: FileSystemDirectoryHandle, goggles?: FileSystemDirectoryHandle | null) {
    try {
      const root = h ?? (await pickDir("drone"));
      if (!root) return;
      if (!(await ensurePermission(root))) return say(t("err.permission"), true);
      await saveRoot(root);
      const gog = goggles === undefined ? savedGoggles : goggles;
      if (goggles !== undefined) await saveGogglesDir(goggles);
      await gogglesAccess(gog);
      const logs = savedLogs.current ?? (await loadLogsDir()) ?? null;
      if (logs) await gogglesAccess(logs);
      const d = await openDirs(root, gog, logs);
      dirsRef.current = d;
      setDirs(d);
      setSavedRoot(root);
      setSavedGoggles(gog);
      setSelectedId(null);
      setThumbs({});
      await scan(d, false, true);
    } catch (e) {
      if ((e as Error).name !== "AbortError") say(String(e), true);
    }
  }

  async function setGogglesFolder(h: FileSystemDirectoryHandle | null) {
    const d = dirsRef.current;
    if (!d) return;
    await saveGogglesDir(h);
    setSavedGoggles(h);
    await gogglesAccess(h);
    const next = { ...d, gogglesExt: h };
    dirsRef.current = next;
    setDirs(next);
    await scan(next, true);
    if (h) say(t("gfolder.linked", { name: h.name }));
  }

  async function linkGogglesFolder() {
    const h = await pickDir("goggles");
    if (h) await setGogglesFolder(h);
  }

  // 비행기록 폴더 (선택): 기체·고글에서 꺼낸 FlightRecords 폴더
  async function linkLogsFolder() {
    const d = dirsRef.current;
    if (!d) return;
    let h: FileSystemDirectoryHandle;
    try {
      h = await (window as any).showDirectoryPicker({ id: "dji-logs", mode: "read" });
    } catch (e) {
      if ((e as Error).name !== "AbortError") say(String(e), true);
      return;
    }
    await saveLogsDir(h);
    savedLogs.current = h;
    const next = { ...d, logsExt: h };
    dirsRef.current = next;
    setDirs(next);
    await scan(next, true);
  }
  // 비행과 시간이 겹치는 비행기록 요약
  const logOf = (f: Flight) => (idx?.logs.length ? matchLog(idx.logs, f.start, f.end) : null);

  async function reconnectGoggles() {
    const d = dirsRef.current;
    if (!d?.gogglesExt) return;
    if (!(await gogglesAccess(d.gogglesExt))) return say(t("gfolder.denied"), true);
    await scan(d, false);
  }

  // ---------- 연속성 분석 (병합 후보 쌍) ----------
  useEffect(() => {
    if (!lib || !idx) return;
    let cancelled = false;
    (async () => {
      const cs = lib.pendingClips;
      for (let i = 1; i < cs.length && !cancelled; i++) {
        const key = pairKey(cs[i - 1], cs[i]);
        if (!lib.decisions[i].candidate || stateRef.current.scores[key] !== undefined) continue;
        const a = proxyRef(idx, cs[i - 1].stem);
        const b = proxyRef(idx, cs[i].stem);
        if (!a || !b) continue;
        try {
          const ga = await grayFrame(await a.handle.getFile(), "last");
          const gb = await grayFrame(await b.handle.getFile(), "first");
          const sc = Math.round(continuity(ga, gb).score * 1000) / 1000;
          if (!cancelled) update((s) => (s.scores[key] = sc));
        } catch {}
      }
    })();
    return () => void (cancelled = true);
  }, [lib?.pendingClips, idx]);

  // ---------- 썸네일 (WebCodecs, LRF 프록시) ----------
  useEffect(() => {
    if (!lib || !idx) return;
    let cancelled = false;
    (async () => {
      const stems = [...new Set(lib.flights.flatMap((f) => f.clips.map((c) => c.stem)))];
      for (const stem of stems) {
        if (cancelled) return;
        if (thumbs[stem]) continue;
        const ref = proxyRef(idx, stem);
        if (!ref) continue;
        try {
          const f = await ref.handle.getFile();
          const url = await frameImage(f, Math.min(1.5, (await mediaInfo(f)).duration / 2), 360);
          if (!cancelled) setThumbs((m) => ({ ...m, [stem]: url }));
        } catch {}
      }
    })();
    return () => void (cancelled = true);
  }, [lib, idx]);

  const selected = useMemo(() => lib?.flights.find((f) => f.id === selectedId) ?? null, [lib, selectedId]);

  // ---------- 비행 데이터 ----------
  const fileOf = async (name: string) => idx?.files.get(name)?.handle.getFile() ?? null;

  // 비행 데이터: 병합본 옆 .telemetry.json → 없으면 원본 클립들의 djmd 트랙. 실패 이유는 숨기지 않고 넘긴다.
  // 폴더를 다시 읽을 때마다 새로 파싱하지 않도록 비행·파일 조합별로 캐시
  async function telemetryOf(f: Flight): Promise<Telemetry | null> {
    const d = dirsRef.current;
    const ix = idxRef.current;
    if (!ix || !d) throw new Error(t("tel.notReady"));
    const key = `${f.id}|${f.output?.name ?? ""}|${f.clips.map((c) => c.name).join()}`;
    let p = telCache.current.get(key);
    if (!p) {
      p = (async () => {
        const why: string[] = [];
        if (f.output?.ref) {
          try {
            const dir = (d as any)[f.output.ref.dir] as FileSystemDirectoryHandle;
            const side = await (await dir.getFileHandle(telemetryFile(f.output.name))).getFile();
            const tel = fromJSON(await side.text());
            if (tel.t.length) return tel;
            why.push(`${telemetryFile(f.output.name)}: 0`);
          } catch (e) {
            why.push(`${telemetryFile(f.output.name)}: ${(e as Error).name}`);
          }
          // 클립 하나짜리는 결과물이 원본 그대로라 영상 안의 비행 데이터를 바로 읽는다 (원본은 이미 옮겨졌을 수 있음)
          if (f.clips.length === 1) {
            try {
              const dir = (d as any)[f.output.ref.dir] as FileSystemDirectoryHandle;
              const tel = await readTelemetry(fileReader(await (await dir.getFileHandle(f.output.name)).getFile()));
              if (tel.t.length) return tel;
            } catch (e) {
              why.push(`${f.output.name}: ${(e as Error).name}`);
            }
          }
        }
        const parts: Telemetry[] = [];
        for (const c of f.clips) {
          const ref = ix.files.get(c.name);
          if (!ref) throw new Error([...why, t("tel.missing", { name: c.name })].join(" · "));
          try {
            parts.push(await readTelemetry(fileReader(await ref.handle.getFile())));
          } catch (e) {
            throw new Error([...why, `${c.name}: ${(e as Error).message}`].join(" · "));
          }
        }
        const tel = concatTelemetry(parts, f.clips.map((c) => c.duration));
        return tel.t.length ? tel : null;
      })();
      telCache.current.set(key, p);
      p.catch((e) => {
        telCache.current.delete(key);
        console.warn("[telemetry]", f.id, e);
      });
    }
    return p;
  }


  async function previewFile(f: Flight) {
    if (f.overlay?.ref) return { file: await f.overlay.ref.handle.getFile(), kind: "overlay" as const };
    if (f.output?.ref) return { file: await f.output.ref.handle.getFile(), kind: "output" as const };
    const ref = idx && proxyRef(idx, f.clips[0].stem);
    return ref ? { file: await ref.handle.getFile(), kind: "proxy" as const } : null;
  }

  function seam(a: Flight["clips"][number], b: Flight["clips"][number]) {
    const key = `${a.stem}>${b.stem}`;
    let p = seamCache.current.get(key);
    if (!p) {
      p = (async () => {
        const fa = await proxyRef(idx!, a.stem)!.handle.getFile();
        const fb = await proxyRef(idx!, b.stem)!.handle.getFile();
        return [await frameImage(fa, a.duration - 0.05, 480), await frameImage(fb, 0, 480)] as [string, string];
      })();
      p.catch(() => seamCache.current.delete(key));
      seamCache.current.set(key, p);
    }
    return p;
  }

  // ---------- 파이프라인: 병합 → 검증 → 오버레이 ----------
  const prefsOf = (id: string) => ({ ...defaultPrefs(), ...stateRef.current.prefs?.[id] });
  const setPrefs = (id: string, patch: Partial<FlightPrefs>) =>
    update((s) => {
      s.prefs ??= {};
      s.prefs[id] = { ...defaultPrefs(), ...s.prefs[id], ...patch };
    });

  async function moveRaw(stem: string, to: FileSystemDirectoryHandle, withMp4: boolean) {
    const d = dirsRef.current!;
    for (const ext of withMp4 ? ["MP4", "LRF", "SRT"] : ["LRF", "SRT"]) {
      const name = `${stem}.${ext}`;
      if (await exists(d.root, name)) await moveFile(d.root, name, to);
    }
  }

  async function doMerge(f: Flight, signal: AbortSignal): Promise<{ name: string; rec: VideoRecord }> {
    const d = dirsRef.current!;
    const title = prefsOf(f.id).title || defaultTitle(f.start);
    const files = await Promise.all(f.clips.map((c) => d.root.getFileHandle(c.name).then((h) => h.getFile())));
    const infos = await Promise.all(files.map(mediaInfo));
    const sourceFrames = infos.reduce((a, x) => a + x.frames, 0);
    const base: VideoRecord = {
      sources: f.clips.map((c) => c.name), title, start: f.start, duration: f.duration,
      clipDurations: f.clips.map((c) => c.duration), joinReasons: f.joins.map((j) => j.reason), youtubeId: f.youtubeId,
    };
    if (f.clips.length === 1) {
      const name = f.clips[0].name;
      await moveFile(d.root, name, d.ready);
      await moveRaw(f.clips[0].stem, d.sources, false);
      return { name, rec: { ...base, verified: { frames: infos[0].frames, sourceFrames, duration: infos[0].duration } } };
    }
    const name = `${f.id}_merged.MP4`;
    if (await exists(d.ready, name)) await d.ready.removeEntry(name); // 이전에 중단된 결과물
    const total = files.reduce((a, x) => a + x.size, 0);
    setJob({ flightId: f.id, phase: "merge", done: 0, total, started: Date.now() });
    const w = await (await d.ready.getFileHandle(name, { create: true })).createWritable();
    try {
      await merge(files.map(fileReader), {
        write: async (c) => {
          if (signal.aborted) throw new DOMException("중단됨", "AbortError");
          await w.write(c as Uint8Array<ArrayBuffer>);
        },
      }, (done) => setJob((j) => j && { ...j, done }));
      await w.close();
    } catch (e) {
      await w.abort().catch(() => {});
      await d.ready.removeEntry(name).catch(() => {});
      throw e;
    }
    // 검증: 결과의 프레임 수 = 원본 합
    setJob({ flightId: f.id, phase: "verify", done: 0, total: 1, started: Date.now() });
    const out = await (await d.ready.getFileHandle(name)).getFile();
    const tr = await parse(fileReader(out));
    const verified = { frames: tr.count, sourceFrames, duration: tr.duration };
    if (tr.count !== sourceFrames) throw new Error(t("verify.fail", { a: tr.count, b: sourceFrames }));
    try {
      const tels = await Promise.all(files.map((x) => readTelemetry(fileReader(x))));
      const w2 = await (await d.ready.getFileHandle(telemetryFile(name), { create: true })).createWritable();
      await w2.write(toJSON(concatTelemetry(tels, f.clips.map((c) => c.duration))));
      await w2.close();
    } catch {}
    for (const c of f.clips) await moveRaw(c.stem, d.sources, true);
    return { name, rec: { ...base, duration: tr.duration, verified } };
  }

  async function doOverlay(f: Flight, outName: string, outRec: VideoRecord, signal: AbortSignal) {
    const d = dirsRef.current!;
    const p = prefsOf(f.id);
    const inReady = await exists(d.ready, outName);
    const dir = inReady ? d.ready : d.uploaded;
    const handle = await dir.getFileHandle(outName);
    const src = await handle.getFile();
    const fl: Flight = { ...f, output: { name: outName, ref: { dir: inReady ? "ready" : "uploaded", handle } } };
    const tel = p.instruments || p.map ? await telemetryOf(fl).catch(() => null) : null; // 비행 데이터가 없으면 고글 OSD 만
    const g = gogglesOf(f);
    const layout = layoutOf(stateRef.current);
    // 고글 파일마다 화면 배율·고정 OSD 통계
    const segs = [];
    for (const x of g.links.filter((x) => x.info)) {
      const a = await analyzeGoggles(x.info!.file).catch(() => null);
      const view = x.link.view ?? a?.view ?? layout.gogglesView ?? "inset";
      segs.push({ file: x.info!.file, offset: x.link.offset, view, stat: a?.stat });
    }
    const goggles = p.goggles && segs.length ? { segments: segs, masks: layout.osd, view: layout.gogglesView } : null;
    if (!tel && !goggles) throw new Error(t("ov.noTelemetry"));
    // 임시 파일에 만들고, 검증까지 끝나면 기존 HUD 영상과 바꾼다 (실패해도 기존 영상은 그대로)
    const name = `${f.id}_hud.MP4`;
    const tmp = `${name}.part`;
    await d.ready.removeEntry(tmp).catch(() => {});
    const w = await (await d.ready.getFileHandle(tmp, { create: true })).createWritable();
    setJob({ flightId: f.id, phase: "render", done: 0, total: 1, started: Date.now() });
    const warned = new Set<string>();
    let res: Awaited<ReturnType<typeof renderOverlay>>;
    try {
      res = await renderOverlay(fileReader(src), {
        write: (c) => w.write(c as Uint8Array<ArrayBuffer>),
        writeAt: (position, c) => w.write({ type: "write", position, data: c as Uint8Array<ArrayBuffer> }),
      }, {
        tel, instruments: p.instruments && !!tel, map: p.map && !!tel, mapsKey: config.mapsKey, goggles, signal, layout,
        onStage: (st) => setJob({ flightId: f.id, phase: st, done: 0, total: 1, started: Date.now() }),
        onWarn: (m) => !warned.has(m) && (warned.add(m), say(m, true)),
        onProgress: (done, total) => setJob((j) => j && { ...j, done, total }),
      });
      await w.close();
      // 검증: 다시 읽어서 프레임 수 확인
      const tr = await parse(fileReader(await (await d.ready.getFileHandle(tmp)).getFile()));
      if (tr.count !== res.frames) throw new Error(t("verify.fail", { a: tr.count, b: res.frames }));
      await d.ready.removeEntry(name).catch(() => {});
      await renameFile(d.ready, tmp, name);
    } catch (e) {
      await w.abort().catch(() => {});
      await d.ready.removeEntry(tmp).catch(() => {});
      throw friendlyError(e);
    }
    if (res.skipped) say(t("ov.skipped", { n: res.skipped }), true);
    if (tel) {
      const w2 = await (await d.ready.getFileHandle(telemetryFile(name), { create: true })).createWritable();
      await w2.write(toJSON(tel));
      await w2.close();
    }
    update((s) => (s.videos[name] = { ...outRec, title: `${outRec.title} (HUD)`, variant: "hud", youtubeId: undefined, playlistId: undefined, uploadedAt: undefined }));
  }

  // 고글 녹화 병합: 비행에 연결된 고글 파일들을 시간순으로 무손실 이어붙임 (프레임 수 검증)
  async function doGogglesMerge(f: Flight, droneSources: string[], baseRec: VideoRecord, signal: AbortSignal) {
    const d = dirsRef.current!;
    const segs = gogglesOf(f).links.filter((x) => x.info).sort((a, b) => a.link.offset - b.link.offset);
    if (segs.length < 2) return null;
    const files = segs.map((x) => x.info!.file);
    const name = `${f.id}_goggles.MP4`;
    if (await exists(d.ready, name)) await d.ready.removeEntry(name);
    const infos = await Promise.all(files.map(mediaInfo));
    const sourceFrames = infos.reduce((a, x) => a + x.frames, 0);
    setJob({ flightId: f.id, phase: "gmerge", done: 0, total: files.reduce((a, x) => a + x.size, 0), started: Date.now() });
    const w = await (await d.ready.getFileHandle(name, { create: true })).createWritable();
    try {
      await merge(files.map(fileReader), {
        write: async (c) => {
          if (signal.aborted) throw new DOMException("중단됨", "AbortError");
          await w.write(c as Uint8Array<ArrayBuffer>);
        },
      }, (done) => setJob((j) => j && { ...j, done }));
      await w.close();
    } catch (e) {
      await w.abort().catch(() => {});
      await d.ready.removeEntry(name).catch(() => {});
      throw e;
    }
    const tr = await parse(fileReader(await (await d.ready.getFileHandle(name)).getFile()));
    if (tr.count !== sourceFrames) throw new Error(t("verify.fail", { a: tr.count, b: sourceFrames }));
    const rec: VideoRecord = {
      ...baseRec, sources: droneSources, title: `${baseRec.title} (${t("tl.goggles")})`, variant: "goggles", gogglesSources: segs.map((x) => x.link.file),
      duration: tr.duration, verified: { frames: tr.count, sourceFrames, duration: tr.duration },
      youtubeId: undefined, playlistId: undefined, uploadedAt: undefined,
    };
    update((s) => (s.videos[name] = rec));
    return name;
  }
  // 연결된 고글 파일이 2개 이상인데 아직 병합본이 없거나 연결이 바뀌었으면 병합
  const gogglesMergeNeeded = (f: Flight) => {
    const files = gogglesOf(f).links.filter((x) => x.info).sort((a, b) => a.link.offset - b.link.offset).map((x) => x.link.file);
    return files.length > 1 && f.gogglesOut?.record.gogglesSources?.join() !== files.join();
  };

  // 비행 하나 처리: 병합 → (고글 병합) → HUD. 실패하면 던진다
  async function runOne(f: Flight, what: { merge: boolean; overlay: boolean; goggles?: boolean }, signal: AbortSignal) {
    const title = prefsOf(f.id).title || t("flight", { n: f.number });
    let outName = f.output?.name;
    let outRec = f.record;
    if (what.merge && f.status === "pending") {
      setJob({ flightId: f.id, phase: "merge", done: 0, total: 1, started: Date.now() });
      const r = await doMerge(f, signal);
      update((s) => (s.videos[r.name] = r.rec));
      outName = r.name;
      outRec = r.rec;
      say(t("toast.merged", { name: title }));
    }
    // 드론 병합과 같이 고글 녹화도 병합 (연결된 고글이 여럿일 때)
    if (outRec && gogglesMergeNeeded(f)) {
      if (await doGogglesMerge(f, outRec.sources, outRec, signal)) say(t("toast.gmerged", { name: title }));
    }
    if (what.overlay && outName && outRec) {
      await doOverlay(f, outName, outRec, signal);
      say(t("toast.overlay", { name: title }));
    }
  }
  const reportError = (title: string, err: unknown) => {
    const e = friendlyError(err);
    const aborted = (e as Error).name === "AbortError";
    say(aborted ? `${title}: ${t("run.cancel")}` : `${title}: ${(e as Error).message ?? e}`, !aborted);
    return aborted;
  };

  async function run(f: Flight, what: { merge: boolean; overlay: boolean; goggles?: boolean }) {
    if (!dirsRef.current || job) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await runOne(f, what, ctrl.signal);
    } catch (err) {
      reportError(prefsOf(f.id).title || t("flight", { n: f.number }), err);
    } finally {
      abortRef.current = null;
      setJob(null);
      await scan(dirsRef.current, true);
    }
  }

  // 일괄 처리 대상: 병합 대기 + HUD 영상이 아직 없는 비행 (HUD·고글 OSD 를 다 끈 비행은 병합만)
  const batchTodo = (): { f: Flight; overlay: boolean }[] =>
    (lib?.flights ?? [])
      .map((f) => {
        const p = prefsOf(f.id);
        const wants = p.instruments || p.map || (p.goggles && gogglesOf(f).links.some((x) => x.info));
        return { f, overlay: wants && !f.overlay };
      })
      .filter((x) => x.f.status === "pending" || x.overlay)
      .sort((a, b) => a.f.start - b.f.start);

  // 모두 처리: 비행마다 차례로. 하나가 실패해도 다음 비행은 계속, 중단하면 거기서 멈춤
  async function runAll() {
    if (!dirsRef.current || job) return;
    const todo = batchTodo();
    if (!todo.length) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let ok = 0, failed = 0;
    try {
      for (const [i, x] of todo.entries()) {
        if (ctrl.signal.aborted) break;
        const title = flightTitle(x.f, stateRef.current, (n) => t("flight", { n }));
        setBatch({ i: i + 1, n: todo.length, label: `${fmtDayShort(x.f.start)} · ${title}` });
        try {
          await runOne(x.f, { merge: true, overlay: x.overlay }, ctrl.signal);
          ok++;
        } catch (err) {
          // 비행 데이터·고글이 없어 HUD 를 못 만드는 비행은 병합만 된 것으로 침
          if ((err as Error)?.message === t("ov.noTelemetry")) {
            ok++;
            say(`${title}: ${t("batch.noTel")}`, true);
          } else if (reportError(title, err)) break;
          else failed++;
        }
      }
    } finally {
      abortRef.current = null;
      setBatch(null);
      setJob(null);
      await scan(dirsRef.current, true);
    }
    if (ok || failed) say(t(failed ? "batch.doneSome" : "batch.done", { n: ok, m: failed }), failed > 0);
  }

  // ---------- 고글 ----------
  function gogglesOf(f: Flight) {
    const list = idx?.goggles ?? [];
    const links = linksOf(stateRef.current, f.id).map((link) => ({ link, info: list.find((g) => g.name === link.file) ?? null }));
    const linked = new Set(links.map((x) => x.link.file));
    const candidates = matchGogglesForClips(f.clips, list).filter((g) => !linked.has(g.name));
    return { links, candidates };
  }

  // 한 비행의 고글 후보들과 시간 맞추기 (결과는 바로 연결 정보에 저장)
  async function syncCore(f: Flight, list: GogglesInfo[], signal: AbortSignal, onStage?: (k: number) => void) {
    const ix = idxRef.current;
    if (!ix) return;
    const clips = [];
    for (const c of f.clips) {
      const ref = proxyRef(ix, c.stem);
      if (!ref) throw new Error(`${c.stem}: missing`);
      clips.push({ file: await ref.handle.getFile(), start: c.start, duration: c.duration });
    }
    for (const [i, g] of list.entries()) {
      const r = await syncGoggles(clips, g, { signal, onStage: (s) => onStage?.(i * 2 + (s === "flight" ? 0 : 1)) });
      update((s) => {
        s.goggles ??= {};
        const links = linksOf(s, f.id).filter((l) => l.file !== g.name);
        links.push({ file: g.name, offset: Math.round(r.offset * 1000) / 1000, score: Math.round(r.score * 1000) / 1000 });
        s.goggles[f.id] = links.sort((a, b) => a.offset - b.offset);
      });
    }
  }

  async function syncGogglesFor(f: Flight, list: GogglesInfo[]) {
    if (!idx || job || !list.length) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setJob({ flightId: f.id, phase: "goggles", done: 0, total: list.length * 2, started: Date.now() });
    try {
      await syncCore(f, list, ctrl.signal, (k) => setJob((j) => j && { ...j, done: k }));
    } catch (e) {
      if ((e as Error).name !== "AbortError") say(`${t("gog.syncing")}: ${e}`, true);
    } finally {
      abortRef.current = null;
      setJob(null);
    }
  }

  // 폴더를 열면 고글 후보가 있는 모든 비행을 차례로 자동 맞춤 (비행·후보 조합마다 한 번만 시도)
  const autoTried = useRef(new Set<string>());
  const autoRunning = useRef(false);
  useEffect(() => {
    if (!lib || !idx || job || autoRunning.current) return;
    const todo = lib.flights
      .map((f) => ({ f, list: gogglesOf(f).candidates }))
      .filter((x) => x.list.length && !autoTried.current.has(`${x.f.id}|${x.list.map((g) => g.name).join()}`));
    if (!todo.length) return;
    autoRunning.current = true;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    (async () => {
      let ok = 0;
      try {
        for (const [i, { f, list }] of todo.entries()) {
          autoTried.current.add(`${f.id}|${list.map((g) => g.name).join()}`);
          setJob({ phase: "autoSync", done: i, total: todo.length, started: Date.now(), label: `${fmtDayShort(f.start)} · ${flightTitle(f, stateRef.current, (n) => t("flight", { n }))}` });
          try {
            await syncCore(f, list, ctrl.signal);
            ok++;
          } catch (e) {
            if ((e as Error).name === "AbortError") throw e;
            console.warn("[autoSync]", f.id, e);
          }
        }
      } catch {}
      abortRef.current = null;
      autoRunning.current = false;
      setJob(null);
      if (ok) say(t("gog.autoSynced", { n: ok }));
    })();
  }, [lib, idx, job]);

  const nudgeGoggles = (f: Flight, file: string, delta: number) =>
    update((s) => {
      const links = linksOf(s, f.id);
      const l = links.find((x) => x.file === file);
      if (l) {
        l.offset = Math.round((l.offset + delta) * 1000) / 1000;
        l.manual = true;
        s.goggles![f.id] = links;
      }
    });
  const setLayout = (l: Layout | null) =>
    update((s) => {
      if (l) s.layout = l;
      else delete s.layout;
    });
  const setGogglesView = (f: Flight, file: string, view: "inset" | "full", manual: boolean) =>
    update((s) => {
      const links = linksOf(s, f.id);
      const l = links.find((x) => x.file === file);
      if (!l || (!manual && l.viewManual)) return;
      l.view = view;
      l.viewManual = manual || undefined;
      s.goggles![f.id] = links;
    });
  const unlinkGoggles = (f: Flight) => update((s) => void delete s.goggles?.[f.id]);

  // 고글 녹화 가져오기. from = "folder": SD 카드(또는 DCIM) 폴더를 고르면 비행과 시간이 겹치는 녹화만 골라 복사
  async function addGoggles(from: "folder" | "files" = "folder") {
    const d = dirsRef.current;
    if (!d || job) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let added = 0, same = 0, unmatched = 0;
    try {
      let picked: File[] = [];
      if (from === "files") {
        const handles: FileSystemFileHandle[] = await (window as any).showOpenFilePicker({
          multiple: true, id: "goggles",
          types: [{ description: "Video", accept: { "video/mp4": [".mp4"], "video/quicktime": [".mov"] } }],
        });
        picked = await Promise.all(handles.map((h) => h.getFile()));
      } else {
        const dir: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker({ id: "goggles-sd", mode: "read" });
        setJob({ phase: "scanGoggles", done: 0, total: 1, started: Date.now(), label: dir.name });
        const all: File[] = [];
        const walk = async (h: FileSystemDirectoryHandle, depth: number) => {
          for await (const [name, e] of (h as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
            if (e.kind === "directory" && depth < 3 && !name.startsWith(".")) await walk(e as FileSystemDirectoryHandle, depth + 1);
            else if (e.kind === "file" && isRootGoggles(name) && !name.startsWith(".")) all.push(await (e as FileSystemFileHandle).getFile());
          }
        };
        await walk(dir, 0);
        // 촬영 시각이 어느 비행과도 겹치지 않으면 건너뜀 (드론 영상 없는 고글 녹화)
        const clips = (lib?.flights ?? []).flatMap((f) => f.clips);
        for (const [i, f] of all.entries()) {
          if (ctrl.signal.aborted) throw new DOMException("중단됨", "AbortError");
          setJob((j) => j && { ...j, done: i, total: all.length });
          try {
            const g = await inspectGoggles(f);
            if (matchGogglesForClips(clips, [g]).length) picked.push(f);
            else unmatched++;
          } catch {
            unmatched++;
          }
        }
      }
      for (const f of picked) {
        // 같은 이름: 크기도 같으면 이미 있는 것, 다르면(다른 SD 카드의 같은 번호) 이름을 바꿔 저장
        let name = f.name;
        if (await exists(d.goggles, name)) {
          if ((await (await d.goggles.getFileHandle(name)).getFile()).size === f.size) {
            same++;
            continue;
          }
          const [stem, ext] = [name.replace(/\.[^.]+$/, ""), name.slice(name.lastIndexOf("."))];
          let k = 2;
          while (await exists(d.goggles, `${stem}_${k}${ext}`)) k++;
          name = `${stem}_${k}${ext}`;
        }
        setJob({ phase: "copy", done: 0, total: f.size, started: Date.now(), label: name });
        const w = await (await d.goggles.getFileHandle(name, { create: true })).createWritable();
        try {
          let done = 0, shown = 0;
          const reader = f.stream().getReader();
          for (;;) {
            if (ctrl.signal.aborted) throw new DOMException("중단됨", "AbortError");
            const { value, done: end } = await reader.read();
            if (end) break;
            await w.write(value);
            done += value.length;
            if (Date.now() - shown > 150) (shown = Date.now()), setJob((j) => j && { ...j, done }); // 진행 표시는 가끔만 (매 조각마다 그리면 느려짐)
          }
          await w.close();
          added++;
        } catch (e) {
          // 중간에 끊긴 파일이 남으면 다음에 "이미 있음"으로 건너뛰게 되므로 지움
          await w.abort().catch(() => {});
          await d.goggles.removeEntry(name).catch(() => {});
          throw e;
        }
      }
      say(t("gog.imported", { n: added, same, skip: unmatched }));
    } catch (e) {
      const name = (e as Error).name;
      if (name === "AbortError" && !ctrl.signal.aborted) return; // 선택 창을 닫음
      say(name === "AbortError" ? `${t("gog.add")}: ${t("run.cancel")}` : String(e), name !== "AbortError");
    } finally {
      abortRef.current = null;
      setJob(null);
      await scan(d, true);
    }
  }


  // ---------- 제외 ----------
  const setOverride = (name: string, key: "excluded" | "mergePrev", v: boolean | undefined) =>
    update((s) => {
      const o = { ...s.overrides[name], [key]: v };
      if (v === undefined) delete o[key];
      if (Object.keys(o).length) s.overrides[name] = o;
      else delete s.overrides[name];
    });

  async function tidyExcluded() {
    const d = dirsRef.current;
    if (!d || !lib) return;
    for (const e of lib.excluded.filter((x) => x.dir === "root")) await moveRaw(e.name.replace(/\.mp4$/i, ""), d.excluded, true).catch((x) => say(String(x), true));
    await scan(d, true);
  }
  async function restoreExcluded(name: string) {
    const d = dirsRef.current;
    if (!d) return;
    const stem = name.replace(/\.mp4$/i, "");
    for (const ext of ["MP4", "LRF", "SRT"]) if (await exists(d.excluded, `${stem}.${ext}`)) await moveFile(d.excluded, `${stem}.${ext}`, d.root);
    setOverride(name, "excluded", false);
    await scan(d, true);
  }

  // ---------- YouTube (옵션) ----------
  const useQuota = (n: number) => update((s) => (s.quota.used += n));
  const perUpload = config.videoCost + (config.playlist ? yt.COST.playlistItemInsert : 0);
  const quotaLeft = () => config.dailyQuota - (stateRef.current.quota.day === quotaDay() ? stateRef.current.quota.used : 0);

  async function ytLogin() {
    try {
      await yt.signIn(config.clientId, account ? "" : "consent");
      setAccount((await yt.channelTitle()) ?? "YouTube");
      useQuota(yt.COST.list);
    } catch (e) {
      say(`${t("up.login")}: ${e}`, true);
    }
  }

  async function ytSync() {
    try {
      if (!yt.signedIn()) await ytLogin();
      const [map, cost] = await yt.listUploadedSources();
      useQuota(cost);
      update((s) => {
        s.remote = map;
        for (const [name, v] of Object.entries(s.videos)) {
          if (v.variant === "goggles") continue; // 고글 병합본은 업로드 대상 아님
          const key = (src: string) => (v.variant === "hud" ? "hud:" : "") + src;
          const id = map[key(v.sources[0])];
          if (id && v.sources.every((x) => map[key(x)] === id)) s.videos[name] = { ...v, youtubeId: id, uploadedAt: v.uploadedAt ?? "sync" };
        }
      });
      say(`${t("up.sync")}: ${Object.keys(map).length}`);
    } catch (e) {
      say(`${t("up.sync")}: ${e}`, true);
    }
  }

  async function ytUpload(items: { flight: Flight; overlay: boolean }[]) {
    if (!dirsRef.current || job) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      if (!yt.signedIn() || yt.tokenMinutesLeft() < 20) await ytLogin();
      if (config.playlist && !playlistRef.current) {
        const [id, cost] = await yt.ensurePlaylist(config.playlist, config.privacy);
        playlistRef.current = id;
        useQuota(cost);
      }
      for (const { flight, overlay } of items) {
        if (ctrl.signal.aborted) break;
        const target = overlay
          ? flight.overlay
          : flight.output && flight.record ? { name: flight.output.name, ref: flight.output.ref, record: flight.record } : null;
        if (!target?.ref) continue;
        if (quotaLeft() < perUpload) {
          say(t("up.quota", { u: stateRef.current.quota.used, d: config.dailyQuota, n: 0 }), true);
          break;
        }
        if (yt.tokenMinutesLeft() < 20) await ytLogin();
        const file = await target.ref.handle.getFile();
        const rec = target.record;
        const custom = prefsOf(flight.id).title;
        setJob({ flightId: flight.id, phase: "upload", done: 0, total: file.size, started: Date.now() });
        let id: string;
        try {
          id = await yt.uploadVideo(file, {
            title: custom ? `${custom}${overlay ? " (HUD)" : ""}` : rec.title,
            description: `Source: ${rec.sources.join(", ")}${overlay ? "\nOverlay: HUD" : ""}`,
            privacy: config.privacy,
            recordingDate: new Date(rec.start).toISOString(),
          }, (dn) => setJob((j) => j && { ...j, done: dn }), ctrl.signal);
        } catch (e) {
          if (e instanceof yt.QuotaError) {
            update((s) => (s.quota.used = Math.max(s.quota.used, config.dailyQuota)));
            say(e.message, true);
            break;
          }
          throw e;
        }
        useQuota(config.videoCost);
        update((s) => (s.videos[target.name] = { ...rec, youtubeId: id, uploadedAt: new Date().toISOString() }));
        if (playlistRef.current) {
          try {
            await yt.addToPlaylist(playlistRef.current, id);
            useQuota(yt.COST.playlistItemInsert);
            update((s) => (s.videos[target.name].playlistId = playlistRef.current!));
          } catch (e) {
            say(String(e), true);
          }
        }
        say(`${t("up.uploaded")}: https://youtu.be/${id}`);
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") say(`${t("up.one")}: ${e}`, true);
    } finally {
      abortRef.current = null;
      setJob(null);
      await scan(dirsRef.current, true);
    }
  }

  const ctx: AppCtx = {
    config, saveConfig, dirs, savedRoot, savedGoggles, logOf, linkLogsFolder, idx, lib, state, view, setView, day, setDay, query, setQuery, sortNew, setSortNew,
    selected, select: setSelectedId, job, log, loading, account, showSettings, setShowSettings,
    batch, batchTodo, runAll, openFolder, pickDir, setGogglesFolder, reconnectGoggles, linkGogglesFolder, refresh: () => scan(dirsRef.current, false, true), setOverride, prefsOf, setPrefs, run, cancel: () => abortRef.current?.abort(),
    thumb: (stem) => thumbs[stem], seam, telemetryOf, previewFile, gogglesOf, gogglesMergeNeeded, setGogglesView, syncGogglesFor, nudgeGoggles, unlinkGoggles, addGoggles,
    layout: layoutOf(state), setLayout,
    tidyExcluded, restoreExcluded, ytLogin, ytSync, ytUpload, quotaLeft, perUpload,
  };
  return (
    <Ctx.Provider value={ctx}>
      <Shell />
    </Ctx.Provider>
  );
}

// 같은 폴더 안에서 이름 바꾸기 (move 미지원이면 복사 후 삭제)
async function renameFile(dir: FileSystemDirectoryHandle, from: string, to: string) {
  const h = await dir.getFileHandle(from);
  if (typeof (h as any).move === "function") {
    try {
      await (h as any).move(to);
      return;
    } catch (e) {
      if ((e as DOMException).name !== "NotSupportedError") throw e;
    }
  }
  const w = await (await dir.getFileHandle(to, { create: true })).createWritable();
  await (await h.getFile()).stream().pipeTo(w);
  await dir.removeEntry(from);
}

// 브라우저 오류를 사용자가 알아볼 말로
function friendlyError(e: unknown) {
  const n = (e as DOMException)?.name;
  if (n === "AbortError") return e;
  if (n === "QuotaExceededError") return new Error(t("err.diskFull"));
  if (n === "NotAllowedError" || n === "SecurityError") return new Error(t("err.permission"));
  if (n === "NotFoundError") return new Error(t("err.fileGone"));
  return e;
}
