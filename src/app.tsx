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
  emptyState, ensurePermission, exists, flushState, loadProject, mergeRecord, prefsDefault, readState, saveProject, telemetryFile, writeState,
  layoutOf, linksOf, type FlightPrefs, type GogglesLink, type Layout, type SavedProject, type State, type VideoRecord,
} from "./store.ts";
import { buildLibrary, flightTitle, mediaInfo, proxyRef, scanIndex, type Dirs, type Flight, type Index, type Library } from "./library.ts";
import { guessFor, isReadonlyPick, migratePicks, resolveDirs, type AircraftDirs, type PickKey, type RolePicks } from "./roles.ts";
import { bestFlightFor, clockSample, medianErr, ownerOfGoggles, shiftGoggles, type Owner } from "./assign.ts";
import { stepsOf as computeSteps, stepTodo as computeTodo, type Steps } from "./steps.ts";
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
export type StepKey = "drone" | "goggles" | "hud";
export type StepTodo = ReturnType<typeof computeTodo>;

export interface AppCtx {
  config: Config;
  saveConfig: (c: Config) => void;
  dirs: Dirs | null;
  savedProject: SavedProject | null;
  logOf: (f: Flight) => FlightLog | null;
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
  batch: { step: StepKey; i: number; n: number; label: string } | null;
  busy: boolean; // 진행 카드가 떠 있거나 일괄 처리 중 → 다른 작업 버튼 비활성
  stepsOf: (f: Flight) => Steps;
  stepTodo: () => StepTodo;
  runStep: (step: StepKey | "all") => Promise<void>;
  log: LogEntry[];
  loading: boolean;
  account: string | null;
  showSettings: boolean;
  setShowSettings: (b: boolean) => void;
  showSetup: boolean;
  setShowSetup: (b: boolean) => void;
  openProject: (project: FileSystemDirectoryHandle, picks: RolePicks) => Promise<void>;
  pickDir: (role: PickKey | "project") => Promise<FileSystemDirectoryHandle | null>;
  setRole: (role: PickKey, h: FileSystemDirectoryHandle | null) => Promise<void>;
  reconnect: (role: PickKey) => Promise<void>;
  dirOf: (f: Flight) => AircraftDirs;
  hasTelemetry: Record<string, boolean>;
  ownerOf: (file: string) => Owner | undefined;
  setGogglesOwner: (file: string, aircraft: string | null) => void;
  linkGogglesTo: (file: string, flightId: string) => Promise<void>;
  aircraftFilter: string | null;
  setAircraftFilter: (a: string | null) => void;
  layoutFor: (aircraft: string) => Layout;
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
  gogglesOf: (f: Flight) => { links: { link: GogglesLink; info: GogglesInfo | null }[]; candidates: GogglesInfo[]; ambiguous: GogglesInfo[] };
  syncGogglesFor: (f: Flight, list: GogglesInfo[]) => Promise<void>;
  nudgeGoggles: (f: Flight, file: string, delta: number) => void;
  unlinkGoggles: (f: Flight) => void;
  setLayout: (l: Layout | null, aircraft: string) => void;
  addGoggles: (from?: "folder" | "files") => Promise<void>;
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
  const [savedProject, setSavedProject] = useState<SavedProject | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [hasTelemetry, setHasTelemetry] = useState<Record<string, boolean>>({});
  const telRef = useRef<Record<string, boolean>>({});
  const telChecks = useRef(new Map<string, Promise<boolean>>());
  const [aircraftFilter, setAircraftFilter] = useState<string | null>(null);
  const libRef = useRef<Library | null>(null);
  const [batch, setBatch] = useState<AppCtx["batch"]>(null);
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

  // 작업 중(진행 카드·일괄 처리·중단 가능한 작업)이면 새 작업을 받지 않는다
  const isBusy = () => !!abortRef.current || !!job || !!batch;
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
    if (dirsRef.current) writeState(dirsRef.current.project, next).catch((e) => say(`state: ${e}`, true));
    return next;
  };

  useEffect(() => {
    loadProject().then((v) => v && setSavedProject({ ...v, picks: migratePicks(v.picks as Record<string, FileSystemDirectoryHandle | null>) }));
    // 개발용: ?opfs → 브라우저 내부 저장소(OPFS)를 폴더로 열기 (헤드리스 검증용, 배포 빌드에서 제거됨)
    if (import.meta.env.DEV && new URLSearchParams(location.search).has("opfs")) {
      const gog = new URLSearchParams(location.search).get("gog"); // ?opfs&gog=a/b → OPFS 하위 폴더를 고글 폴더로
      navigator.storage.getDirectory().then(async (h) => {
        let g: FileSystemDirectoryHandle | null = null;
        if (gog) for (const part of gog.split("/")) g = await (g ?? h).getDirectoryHandle(part, { create: true });
        openProject(h, g ? { gogglesRaw: g } : {});
      });
    }
  }, []);

  // 작업 중: 화면 꺼짐(절전) 막기 + 페이지 닫기 전에 경고
  useEffect(() => {
    if (!job && !batch) return;
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
  }, [!!job || !!batch]);

  // ---------- 스캔 ----------
  // reload: 폴더를 새로 열 때만 상태 파일을 디스크에서 읽는다. 그 외에는 메모리 상태가 최신
  // (작업 직후 다시 읽으면 아직 저장 중인 기록을 이전 내용으로 덮어쓰게 됨)
  async function scan(d = dirsRef.current, quiet = false, reload = false): Promise<Library | null> {
    if (!d) return null;
    if (!quiet) setLoading(true);
    try {
      await flushState();
      let st = stateRef.current;
      if (reload) {
        st = await readState(d.project);
        if (st.quota.day !== quotaDay()) st.quota = { day: quotaDay(), used: 0 };
        stateRef.current = st;
        setStateRaw(st);
      }
      // 지난번에 브라우저가 꺼지는 등으로 남은 임시 파일 정리 (작업 중이 아닐 때만)
      if (reload && !abortRef.current)
        for (const dir of [...d.aircraft.flatMap((a) => [a.merged, a.hud]), d.gogglesMerged])
          for await (const [name] of (dir as any).entries() as AsyncIterable<[string]>)
            if (name.endsWith(".part")) await dir.removeEntry(name).catch(() => {});
      const ix = await scanIndex(d);
      setIdx(ix);
      idxRef.current = ix;
      const l = await buildLibrary(ix, st, config);
      applyLib(l);
      return l;
    } catch (e) {
      say(String(e), true);
      return null;
    } finally {
      setLoading(false);
    }
  }

  // 기록 없이 찾은 병합본(프레임 수 확인됨)은 상태에 기록해 둔다
  function applyLib(l: Library) {
    libRef.current = l;
    setLib(l);
    if (l.adopt.length) update((s) => l.adopt.forEach((a) => (s.videos[a.name] ??= a.rec)));
  }

  // 판단 기준·수동 선택이 바뀌면 묶음을 다시 계산 (파일 재스캔 없이)
  useEffect(() => {
    if (idx) buildLibrary(idx, state, config).then(applyLib);
  }, [state.overrides, state.scores, state.videos, state.remote, config.minDuration, config.maxGap, config.simMax]);

  // 폴더 고르기 창. 닫으면 null. 원본 역할은 읽기, 나머지는 쓰기 권한
  async function pickDir(role: PickKey | "project") {
    try {
      const mode = role !== "project" && isReadonlyPick(role) ? "read" : "readwrite";
      const id = `contrail-${role.replace(/[^a-z0-9_-]/gi, "-")}`.slice(0, 32);
      return (await (window as any).showDirectoryPicker({ id, mode })) as FileSystemDirectoryHandle;
    } catch (e) {
      if ((e as Error).name !== "AbortError") say(String(e), true);
      return null;
    }
  }

  // 원본 폴더 권한: 거절되거나 SD 카드가 빠져 있어도 프로젝트는 열리게 한다 (사이드바에서 다시 연결)
  const readAccess = (h: FileSystemDirectoryHandle | null | undefined) => (h ? ensurePermission(h, "read").catch(() => false) : Promise.resolve(false));

  // 프로젝트 열기: 하위 폴더 이름으로 역할을 추정하고, 사용자가 바꾼 칸(picks)을 덮어쓴다. 새 결과 폴더는 여기서 만든다
  async function openProject(project: FileSystemDirectoryHandle, picks: RolePicks) {
    if (isBusy()) return;
    try {
      if (!(await ensurePermission(project))) return say(t("err.permission"), true);
      for (const [role, h] of Object.entries(picks) as [PickKey, FileSystemDirectoryHandle | null][]) {
        if (!h) continue;
        if (isReadonlyPick(role)) await readAccess(h);
        else if (!(await ensurePermission(h).catch(() => false))) return say(t("err.permission"), true);
      }
      const guess = await guessFor(project, !!picks.gogglesRaw);
      const d = await resolveDirs(project, guess, picks);
      // 기체 정보는 프로젝트마다 다시
      telChecks.current.clear();
      telRef.current = {};
      setHasTelemetry({});
      const saved = { project, picks };
      await saveProject(saved);
      dirsRef.current = d;
      setDirs(d);
      setSavedProject(saved);
      setSelectedId(null);
      setThumbs({});
      setShowSetup(false);
      await scan(d, false, true);
    } catch (e) {
      if ((e as Error).name !== "AbortError") say(String(e), true);
    }
  }

  async function setRole(role: PickKey, h: FileSystemDirectoryHandle | null) {
    if (!savedProject) return;
    await openProject(savedProject.project, { ...savedProject.picks, [role]: h });
  }

  async function reconnect(role: PickKey) {
    const d = dirsRef.current;
    const m = /^aircraft:(.+):(raw|merged|hud)$/.exec(role);
    const h = m ? d?.aircraft.find((a) => a.id === m[1])?.[m[2] as "raw" | "merged" | "hud"] : role === "gogglesRaw" ? d?.gogglesRaw : role === "logs" ? d?.logs : d?.gogglesMerged;
    if (!h) return;
    if (!(await readAccess(h))) return say(t("gfolder.denied"), true);
    await scan(dirsRef.current, false);
  }

  // 비행과 시간이 겹치는 비행기록 요약
  const logOf = (f: Flight) => (idx?.logs.length ? matchLog(idx.logs, f.start, f.end) : null);

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

  // 비행이 속한 기체의 폴더 (없으면 첫 기체)
  const dirOf = (f: Flight): AircraftDirs => {
    const d = dirsRef.current!;
    return d.aircraft.find((a) => a.id === f.aircraft) ?? d.aircraft[0];
  };

  // 기체별 비행 데이터 유무: 첫 원본 클립에 유효한 GPS 또는 자세가 있는지 (기체마다 1회, 기다릴 수 있음)
  function aircraftHasTel(id: string): Promise<boolean> {
    let p = telChecks.current.get(id);
    if (!p) {
      p = (async () => {
        const ix = idxRef.current;
        const first = ix && [...ix.files.values()].find((r) => r.aircraft === id && r.dir === "raw" && /\.mp4$/i.test(r.handle.name));
        let ok = true; // 원본이 없으면 판단 못 함 → 기본값(켬)
        if (first) {
          try {
            const tel = await readTelemetry(fileReader(await first.handle.getFile()));
            ok = tel.t.length > 0 && (tel.lat.some((v) => !Number.isNaN(v) && v !== 0) || tel.pitch.some((v) => v !== 0) || tel.roll.some((v) => v !== 0));
          } catch {
            ok = false;
          }
        }
        telRef.current = { ...telRef.current, [id]: ok };
        setHasTelemetry(telRef.current);
        return ok;
      })();
      telChecks.current.set(id, p);
    }
    return p;
  }
  useEffect(() => {
    idx?.aircraft.forEach((a) => void aircraftHasTel(a.id));
  }, [idx]);

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
        if (f.output) {
          try {
            const sideName = telemetryFile(f.output.name);
            const sideHandle = await dirOf(f).merged.getFileHandle(sideName).catch(() => ix.files.get(sideName)?.handle);
            if (!sideHandle) throw new DOMException("", "NotFoundError");
            const side = await sideHandle.getFile();
            const tel = fromJSON(await side.text());
            if (tel.t.length) return tel;
            why.push(`${telemetryFile(f.output.name)}: 0`);
          } catch (e) {
            why.push(`${telemetryFile(f.output.name)}: ${(e as Error).name}`);
          }
          // 클립 하나짜리는 결과물이 원본 그대로라 영상 안의 비행 데이터를 바로 읽는다
          if (f.clips.length === 1 && f.output.ref) {
            try {
              const tel = await readTelemetry(fileReader(await f.output.ref.handle.getFile()));
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
  // 기본값은 기체에 따라: 비행 데이터가 없는 기체는 계기·지도 끔
  const basePrefs = (id: string) => {
    const a = libRef.current?.flights.find((f) => f.id === id)?.aircraft;
    return prefsDefault(a ? telRef.current[a] ?? true : true);
  };
  const prefsOf = (id: string) => ({ ...basePrefs(id), ...stateRef.current.prefs?.[id] });
  const setPrefs = (id: string, patch: Partial<FlightPrefs>) =>
    update((s) => {
      s.prefs ??= {};
      s.prefs[id] = { ...basePrefs(id), ...s.prefs[id], ...patch };
    });

  // 드론 병합: 원본은 읽기만 하고 드론 병합본 폴더에 쓴다 (클립 2개 이상인 비행만)
  async function doMerge(f: Flight, signal: AbortSignal): Promise<{ name: string; rec: VideoRecord }> {
    const d = dirsRef.current!;
    const ix = idxRef.current!;
    const title = prefsOf(f.id).title || defaultTitle(f.start);
    const files = await Promise.all(f.clips.map((c) => {
      const ref = ix.files.get(c.name);
      if (!ref) throw new Error(t("err.fileGone"));
      return ref.handle.getFile();
    }));
    const infos = await Promise.all(files.map(mediaInfo));
    const sourceFrames = infos.reduce((a, x) => a + x.frames, 0);
    const base: VideoRecord = {
      sources: f.clips.map((c) => c.name), title, start: f.start, duration: f.duration,
      clipDurations: f.clips.map((c) => c.duration), joinReasons: f.joins.map((j) => j.reason), youtubeId: f.youtubeId,
    };
    const name = `${f.id}_merged.MP4`;
    const tmp = `${name}.part`;
    const out = dirOf(f).merged;
    // 기록 없는 같은 이름 병합본은 사용자가 둔 파일일 수 있으니 덮어쓰지 않는다
    if ((await exists(out, name)) && !stateRef.current.videos[name]) throw new Error(t("err.orphan", { name }));
    await out.removeEntry(tmp).catch(() => {});
    const total = files.reduce((a, x) => a + x.size, 0);
    setJob({ flightId: f.id, phase: "merge", done: 0, total, started: Date.now() });
    const w = await (await out.getFileHandle(tmp, { create: true })).createWritable();
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
      await out.removeEntry(tmp).catch(() => {});
      throw e;
    }
    // 검증: 결과의 프레임 수 = 원본 합. 통과해야 임시 파일을 결과 이름으로 바꾼다
    setJob({ flightId: f.id, phase: "verify", done: 0, total: 1, started: Date.now() });
    const tr = await parse(fileReader(await (await out.getFileHandle(tmp)).getFile()));
    const verified = { frames: tr.count, sourceFrames, duration: tr.duration };
    if (tr.count !== sourceFrames) {
      await out.removeEntry(tmp).catch(() => {});
      throw new Error(t("verify.fail", { a: tr.count, b: sourceFrames }));
    }
    await out.removeEntry(name).catch(() => {});
    await renameFile(out, tmp, name);
    try {
      const tels = await Promise.all(files.map((x) => readTelemetry(fileReader(x))));
      const w2 = await (await out.getFileHandle(telemetryFile(name), { create: true })).createWritable();
      await w2.write(toJSON(concatTelemetry(tels, f.clips.map((c) => c.duration))));
      await w2.close();
    } catch {}
    return { name, rec: { ...base, duration: tr.duration, verified, ...(f.aircraft !== "default" ? { aircraft: f.aircraft } : {}) } };
  }

  // 병합본(드론 병합본 폴더) 또는 원본(클립 하나짜리) 파일 핸들
  async function outputHandle(name: string, f: Flight) {
    const h = await dirOf(f).merged.getFileHandle(name).catch(() => idxRef.current?.files.get(name)?.handle ?? idxRef.current?.files.get(`${f.aircraft}/${name}`)?.handle);
    if (!h) throw new Error(t("err.fileGone"));
    return h;
  }

  async function doOverlay(f: Flight, outName: string, outRec: VideoRecord, signal: AbortSignal) {
    const d = dirsRef.current!;
    await aircraftHasTel(f.aircraft); // 비행 데이터 유무를 알아야 기본값(계기·지도)이 정해짐
    const p = prefsOf(f.id);
    const handle = await outputHandle(outName, f);
    const src = await handle.getFile();
    const fl: Flight = { ...f, output: { name: outName, ref: { dir: f.clips.length > 1 ? "merged" : "raw", handle, aircraft: f.aircraft } } };
    const tel = p.instruments || p.map ? await telemetryOf(fl).catch(() => null) : null; // 비행 데이터가 없으면 고글 OSD 만
    const g = gogglesOf(f);
    const layout = layoutOf(stateRef.current, f.aircraft);
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
    const out = dirOf(f).hud;
    await out.removeEntry(tmp).catch(() => {});
    const w = await (await out.getFileHandle(tmp, { create: true })).createWritable();
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
      const tr = await parse(fileReader(await (await out.getFileHandle(tmp)).getFile()));
      if (tr.count !== res.frames) throw new Error(t("verify.fail", { a: tr.count, b: res.frames }));
      await out.removeEntry(name).catch(() => {});
      await renameFile(out, tmp, name);
    } catch (e) {
      await w.abort().catch(() => {});
      await out.removeEntry(tmp).catch(() => {});
      throw friendlyError(e);
    }
    if (res.skipped) say(t("ov.skipped", { n: res.skipped }), true);
    if (tel) {
      const w2 = await (await out.getFileHandle(telemetryFile(name), { create: true })).createWritable();
      await w2.write(toJSON(tel));
      await w2.close();
    }
    // 클립 하나짜리(원본이 결과)는 기록이 아직 없으면 같이 저장
    if (f.synthetic) update((s) => void (s.videos[outName] ??= outRec));
    update((s) => (s.videos[name] = { ...outRec, ...(f.aircraft !== "default" ? { aircraft: f.aircraft } : {}), title: `${outRec.title} (HUD)`, variant: "hud", youtubeId: undefined, playlistId: undefined, uploadedAt: undefined }));
  }

  // 고글 녹화 병합: 비행에 연결된 고글 파일들을 시간순으로 무손실 이어붙임 (프레임 수 검증)
  async function doGogglesMerge(f: Flight, droneSources: string[], baseRec: VideoRecord, signal: AbortSignal) {
    const d = dirsRef.current!;
    const segs = gogglesOf(f).links.filter((x) => x.info).sort((a, b) => a.link.offset - b.link.offset);
    if (segs.length < 2) return null;
    const files = segs.map((x) => x.info!.file);
    const name = `${f.id}_goggles.MP4`;
    const out = d.gogglesMerged;
    if (await exists(out, name)) await out.removeEntry(name);
    const infos = await Promise.all(files.map(mediaInfo));
    const sourceFrames = infos.reduce((a, x) => a + x.frames, 0);
    setJob({ flightId: f.id, phase: "gmerge", done: 0, total: files.reduce((a, x) => a + x.size, 0), started: Date.now() });
    const w = await (await out.getFileHandle(name, { create: true })).createWritable();
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
      await out.removeEntry(name).catch(() => {});
      throw e;
    }
    const tr = await parse(fileReader(await (await out.getFileHandle(name)).getFile()));
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

  // ---------- 단계: ① 드론 병합 → ② 고글(맞춤·병합) → ③ HUD ----------
  const titleOf = (f: Flight) => prefsOf(f.id).title || t("flight", { n: f.number });
  const gogglesFacts = (f: Flight) => {
    const g = gogglesOf(f);
    const linked = g.links.filter((x) => x.info).sort((a, b) => a.link.offset - b.link.offset).map((x) => x.link.file);
    return { linked, candidates: g.candidates.length + g.ambiguous.length, mergedSources: f.gogglesOut?.record.gogglesSources };
  };
  const stepsOf = (f: Flight) => computeSteps(f, gogglesFacts(f), prefsOf(f.id));
  const todoOf = (l: Library | null) => computeTodo((l?.flights ?? []).map((f) => ({ f, s: stepsOf(f) })));

  // 단계 하나를 비행 하나에. 실패하면 던진다. 결과 = 이 단계가 만든 결과물 이름·기록 (HUD 단계가 이어 쓰도록)
  async function stepOne(step: StepKey, f: Flight, signal: AbortSignal, out?: { name: string; rec: VideoRecord }) {
    const title = titleOf(f);
    if (step === "drone") {
      if (f.status !== "pending") return out;
      const r = await doMerge(f, signal);
      update((s) => (s.videos[r.name] = mergeRecord(s.videos[r.name], r.rec)));
      say(t("toast.merged", { name: title }));
      return r;
    }
    const name = out?.name ?? f.output?.name;
    const rec = out?.rec ?? f.record;
    if (step === "goggles") {
      // 주인 기체가 애매한 고글 녹화부터: 후보 기체마다 화면 내용 점수로 판정
      for (const a of gogglesOf(f).ambiguous) await resolveOwner(a, signal);
      const g = gogglesOf(f);
      if (g.candidates.length) {
        setJob({ flightId: f.id, phase: "goggles", done: 0, total: g.candidates.length * 2, started: Date.now() });
        await syncCore(f, g.candidates, signal, (k) => setJob((j) => j && { ...j, done: k }));
      }
      // 고글 병합은 드론 쪽 결과(기록)가 있어야 함: 병합 대기 비행은 맞춤만
      if (rec && f.status !== "pending" && gogglesMergeNeeded(f) && (await doGogglesMerge(f, rec.sources, rec, signal))) say(t("toast.gmerged", { name: title }));
      return out;
    }
    if (!name || !rec) return out;
    await doOverlay(f, name, rec, signal);
    say(t("toast.overlay", { name: title }));
    return out;
  }
  const reportError = (title: string, err: unknown) => {
    const e = friendlyError(err);
    const aborted = (e as Error).name === "AbortError";
    say(aborted ? `${title}: ${t("run.cancel")}` : `${title}: ${(e as Error).message ?? e}`, !aborted);
    return aborted;
  };

  // 비행 하나 (프로젝트 화면의 버튼): 병합 → (고글 병합) → HUD
  async function run(f: Flight, what: { merge: boolean; overlay: boolean; goggles?: boolean }) {
    if (!dirsRef.current || isBusy()) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      let out: { name: string; rec: VideoRecord } | undefined;
      if (what.merge) out = await stepOne("drone", f, ctrl.signal);
      if (out || f.status !== "pending") {
        const g = gogglesOf(f);
        if (g.links.some((x) => x.info) && gogglesMergeNeeded(f)) {
          const rec = out?.rec ?? f.record;
          if (rec && (await doGogglesMerge(f, rec.sources, rec, ctrl.signal))) say(t("toast.gmerged", { name: titleOf(f) }));
        }
      }
      if (what.overlay) await stepOne("hud", f, ctrl.signal, out);
    } catch (err) {
      reportError(titleOf(f), err);
    } finally {
      abortRef.current = null;
      setJob(null);
      await scan(dirsRef.current, true);
    }
  }

  // 단계별 일괄: 대상 비행을 시간순으로 하나씩. 하나가 실패해도 다음 비행은 계속, 중단하면 거기서 멈춤.
  // "all" = ① 전체 → ② 전체 → ③ 전체 (단계 사이에 다시 읽어서 앞 단계 결과를 반영)
  async function runStep(step: StepKey | "all") {
    if (!dirsRef.current || isBusy()) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let ok = 0, failed = 0, blocked = 0;
    let current = lib;
    try {
      outer: for (const st of step === "all" ? (["drone", "goggles", "hud"] as StepKey[]) : [step]) {
        const todo = todoOf(current);
        if (st === "hud") blocked = todo.hudBlocked;
        const list = todo[st];
        for (const [i, f] of list.entries()) {
          if (ctrl.signal.aborted) break outer;
          const title = flightTitle(f, stateRef.current, (n) => t("flight", { n }));
          setBatch({ step: st, i: i + 1, n: list.length, label: `${fmtDayShort(f.start)} · ${title}` });
          try {
            await stepOne(st, f, ctrl.signal);
            ok++;
          } catch (err) {
            // 비행 데이터·고글이 없어 HUD 를 못 만드는 비행은 알리고 넘어감
            if (st === "hud" && (err as Error)?.message === t("ov.noTelemetry")) say(`${title}: ${t("batch.noTel")}`, true);
            else if (reportError(title, err)) break outer;
            else failed++;
          }
        }
        current = (await scan(dirsRef.current, true)) ?? current;
      }
    } finally {
      abortRef.current = null;
      setBatch(null);
      setJob(null);
    }
    if (ok || failed) say(t(failed ? "batch.doneSome" : "batch.done", { n: ok, m: failed }), failed > 0);
    if (blocked) say(t("step.hudBlocked", { n: blocked }), true);
  }

  // ---------- 고글 (공용: 녹화마다 주인 기체 하나) ----------
  const clockErr = (aircraft: string, day: string) => medianErr(stateRef.current.clock?.[aircraft]?.[day] ?? []);
  function owners() {
    const st = stateRef.current;
    const flights = libRef.current?.flights ?? [];
    const links: Record<string, { file: string }[]> = {};
    for (const f of flights) links[f.id] = linksOf(st, f.id);
    return ownerOfGoggles(idxRef.current?.goggles ?? [], flights, links, clockErr, st.gogglesOwner ?? {});
  }
  const ownerOf = (file: string) => owners().get(file);

  function gogglesOf(f: Flight) {
    const list = idxRef.current?.goggles ?? idx?.goggles ?? [];
    const links = linksOf(stateRef.current, f.id).map((link) => ({ link, info: list.find((g) => g.name === link.file) ?? null }));
    const linked = new Set(links.map((x) => x.link.file));
    const own = owners();
    const err = clockErr(f.aircraft, f.day);
    // 이 기체 녹화만, 그 기체 시계 오차로 시각을 보정해 클립별 시간 겹침으로 찾는다
    const mine = list.filter((g) => own.get(g.name)?.aircraft === f.aircraft && !linked.has(g.name)).map((g) => shiftGoggles(g, err));
    const candidates = matchGogglesForClips(f.clips, mine);
    const ambiguous = matchGogglesForClips(f.clips, list.filter((g) => own.get(g.name)?.by === "ambiguous" && own.get(g.name)!.candidates.includes(f.aircraft)).map((g) => shiftGoggles(g, err)));
    return { links, candidates, ambiguous };
  }

  async function clipRefs(f: Flight) {
    const ix = idxRef.current!;
    const clips = [];
    for (const c of f.clips) {
      const ref = proxyRef(ix, c.stem);
      if (!ref) throw new Error(t("tel.missing", { name: c.stem }));
      clips.push({ file: await ref.handle.getFile(), start: c.start, duration: c.duration });
    }
    return clips;
  }

  // 한 비행의 고글 후보들과 시간 맞추기 (결과는 바로 연결 정보에 저장, 확실하면 기체 시계 오차도 배움)
  async function syncCore(f: Flight, list: GogglesInfo[], signal: AbortSignal, onStage?: (k: number) => void, search?: number) {
    if (!idxRef.current) return;
    const clips = await clipRefs(f);
    for (const [i, g] of list.entries()) {
      const r = await syncGoggles(clips, g, { signal, search, onStage: (s) => onStage?.(i * 2 + (s === "flight" ? 0 : 1)) });
      // 원래(보정 전) 고글 시각 기준 절대 오차 → 같은 호출 안에서 여러 녹화를 맞춰도 쌓이지 않음
      const orig = idxRef.current?.goggles.find((x) => x.name === g.name) ?? g;
      const sample = clockSample(orig.start, f.start, r.offset, r.score);
      update((s) => {
        s.goggles ??= {};
        const links = linksOf(s, f.id).filter((l) => l.file !== g.name);
        links.push({ file: g.name, offset: Math.round(r.offset * 1000) / 1000, score: Math.round(r.score * 1000) / 1000 });
        s.goggles[f.id] = links.sort((a, b) => a.offset - b.offset);
        if (sample !== null) {
          s.clock ??= {};
          s.clock[f.aircraft] ??= {};
          (s.clock[f.aircraft][f.day] ??= []).push(sample);
        }
      });
    }
  }

  // 주인 기체가 애매한 녹화: 후보 기체마다 가장 많이 겹치는 비행과 맞춰 점수가 높은 기체로 (차이 0.1 이상일 때만)
  async function resolveOwner(shifted: GogglesInfo, signal: AbortSignal) {
    const own = ownerOf(shifted.name);
    if (own?.by !== "ambiguous") return;
    // gogglesOf 가 넘긴 녹화는 이미 한 기체 오차로 보정돼 있으니 원래 녹화에서 기체마다 한 번만 보정
    const g = idxRef.current?.goggles.find((x) => x.name === shifted.name) ?? shifted;
    const scores: { aircraft: string; score: number }[] = [];
    for (const a of own.candidates) {
      const fs = (libRef.current?.flights ?? []).filter((f) => f.aircraft === a);
      const d = new Date(g.start);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; // 비행 day 와 같은 형식
      const best = bestFlightFor(g, fs, clockErr(a, day));
      if (!best) continue;
      try {
        const r = await syncGoggles(await clipRefs(best), shiftGoggles(g, clockErr(a, best.day)), { signal });
        scores.push({ aircraft: a, score: r.score });
      } catch (e) {
        if ((e as Error).name === "AbortError") throw e;
      }
    }
    scores.sort((x, y) => y.score - x.score);
    if (scores.length && (scores.length === 1 || scores[0].score - scores[1].score >= 0.1)) setGogglesOwner(g.name, scores[0].aircraft);
    else say(t("gog.ownerAsk", { name: g.name }), true);
  }

  const setGogglesOwner = (file: string, aircraft: string | null) =>
    update((s) => {
      s.gogglesOwner ??= {};
      if (aircraft) s.gogglesOwner[file] = aircraft;
      else delete s.gogglesOwner[file];
    });

  // 사용자가 고른 비행에 직접 연결: 시계를 믿을 수 없으니 넓게(±10분) 찾는다
  async function linkGogglesTo(file: string, flightId: string) {
    const f = libRef.current?.flights.find((x) => x.id === flightId);
    const g = idxRef.current?.goggles.find((x) => x.name === file);
    if (!f || !g || isBusy()) return;
    setGogglesOwner(file, f.aircraft);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setJob({ flightId: f.id, phase: "goggles", done: 0, total: 2, started: Date.now() });
    try {
      await syncCore(f, [shiftGoggles(g, clockErr(f.aircraft, f.day))], ctrl.signal, (k) => setJob((j) => j && { ...j, done: k }), 600);
    } catch (e) {
      if ((e as Error).name !== "AbortError") say(`${t("gog.syncing")}: ${e}`, true);
    } finally {
      abortRef.current = null;
      setJob(null);
    }
  }

  async function syncGogglesFor(f: Flight, list: GogglesInfo[]) {
    if (!idx || isBusy() || !list.length) return;
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
  const setLayout = (l: Layout | null, aircraft: string) =>
    update((s) => {
      s.layouts ??= {};
      if (l) s.layouts[aircraft] = l;
      else delete s.layouts[aircraft];
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
    if (!d || isBusy()) return;
    // 복사할 곳 = 고글 원본 폴더 (이때만 쓰기 권한). 없으면 프로젝트에 goggles_raw 를 만들어 고글 원본으로 정함
    let target = d.gogglesRaw;
    if (target && !(await ensurePermission(target).catch(() => false))) return say(t("err.permission"), true);
    const makeTarget = async () => {
      if (target) return target;
      target = await d.project.getDirectoryHandle("goggles_raw", { create: true });
      return target;
    };
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
        const dest = await makeTarget();
        let name = f.name;
        if (await exists(dest, name)) {
          if ((await (await dest.getFileHandle(name)).getFile()).size === f.size) {
            same++;
            continue;
          }
          const [stem, ext] = [name.replace(/\.[^.]+$/, ""), name.slice(name.lastIndexOf("."))];
          let k = 2;
          while (await exists(dest, `${stem}_${k}${ext}`)) k++;
          name = `${stem}_${k}${ext}`;
        }
        setJob({ phase: "copy", done: 0, total: f.size, started: Date.now(), label: name });
        const w = await (await dest.getFileHandle(name, { create: true })).createWritable();
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
          await dest.removeEntry(name).catch(() => {});
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
      if (target && !d.gogglesRaw) await setRole("gogglesRaw", target);
      else await scan(d, true);
    }
  }


  // ---------- 제외 (상태로만; 원본 파일은 옮기지 않음) ----------
  const setOverride = (name: string, key: "excluded" | "mergePrev", v: boolean | undefined) =>
    update((s) => {
      const o = { ...s.overrides[name], [key]: v };
      if (v === undefined) delete o[key];
      if (Object.keys(o).length) s.overrides[name] = o;
      else delete s.overrides[name];
    });

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
    if (!dirsRef.current || isBusy()) return;
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
    config, saveConfig, dirs, savedProject, logOf, idx, lib, state, view, setView, day, setDay, query, setQuery, sortNew, setSortNew,
    selected, select: setSelectedId, job, log, loading, account, showSettings, setShowSettings, showSetup, setShowSetup,
    batch, busy: !!job || !!batch, stepsOf, stepTodo: () => todoOf(lib), runStep, openProject, pickDir, setRole, reconnect,
    refresh: async () => void (await scan(dirsRef.current, false, true)), setOverride, prefsOf, setPrefs, run, cancel: () => abortRef.current?.abort(),
    thumb: (stem) => thumbs[stem], seam, telemetryOf, previewFile, gogglesOf, gogglesMergeNeeded, setGogglesView, syncGogglesFor, nudgeGoggles, unlinkGoggles, addGoggles,
    layoutFor: (a: string) => layoutOf(state, a), setLayout, dirOf, hasTelemetry, ownerOf, setGogglesOwner, linkGogglesTo, aircraftFilter, setAircraftFilter,
    ytLogin, ytSync, ytUpload, quotaLeft, perUpload,
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
