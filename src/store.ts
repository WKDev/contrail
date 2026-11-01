// 폴더 구조 + 상태 파일(dji_state.json) 관리. File System Access API (Chrome/Edge 전용).
//
//   <루트>/            1. 병합대기 (SD카드에서 복사한 원본 DJI_*.MP4/.LRF/.SRT)
//   <루트>/2_ready/    2. 병합완료 = 업로드 대기
//   <루트>/3_uploaded/ 3. 업로드 완료
//   <루트>/_sources/   병합에 사용된 원본 (확인 후 삭제해도 됨)
//   <루트>/_excluded/  자동/수동 제외된 클립
import type { Override } from "./plan.ts";

export const DIRS = { ready: "2_ready", uploaded: "3_uploaded", sources: "_sources", excluded: "_excluded", goggles: "goggles" } as const;
export const STATE_FILE = "dji_state.json";
export const telemetryFile = (videoName: string) => `${videoName}.telemetry.json`;
export const RAW_RE = /^(DJI_\d{14}_\d{4}_D)\.(MP4|LRF|SRT)$/i;

export interface VideoRecord {
  sources: string[]; // 원본 MP4 파일명
  variant?: "hud" | "goggles"; // HUD 합성본 / 고글 녹화 병합본
  gogglesSources?: string[]; // variant "goggles": 이어붙인 고글 파일명
  title: string;
  start: number;
  duration: number;
  youtubeId?: string;
  playlistId?: string;
  uploadedAt?: string;
  clipDurations?: number[]; // 원본 클립별 길이 (병합 막대 표시용)
  joinReasons?: ("auto" | "scene" | "manual")[]; // 이음매별 병합 사유
  verified?: { frames: number; sourceFrames: number; duration: number };
}

// 비행별 오버레이 설정 (key = 첫 클립 stem)
// 화면 배치: 모든 좌표는 출력 프레임 기준 0~1 (왼쪽 위 기준 x, y, 너비 w, 높이 h)
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
// 고글 화면에서 잘라 같은 위치에 붙일 영역
export interface OsdMask extends Box {
  shape?: "rect" | "ellipse";
  feather?: number; // 가장자리 블러 (화면 높이 비율)
  key?: boolean; // 검은 배경 제거 (밝기 키)
}
// 숫자 표시: 레이블·값·단위 칸을 나누고 값은 고정 폭 칸에 오른쪽 정렬
export interface HudText {
  num?: "mono" | "seg7" | "theme"; // 모노스페이스 / 7-세그먼트 / 스타일 글꼴
  scale?: number; // 글자 크기 배율
  color?: string | null; // 값 색 (null = 스타일 기본)
  segBg?: boolean; // 7-세그먼트 숫자 뒤에 검은 판
}
// HUD 위젯: 화면에 올릴 계기·수치 하나. style 이 있으면 그 위젯만 다른 스타일(테마)로 그림
export type WidgetKind = "attitude" | "compass" | "tape" | "horizon" | "map" | "readouts" | "speed" | "alt" | "vs" | "dist" | "clock" | "coords";
export interface Widget extends Box {
  id: string;
  kind: WidgetKind;
  style?: string;
}
export interface Layout {
  style?: string; // HUD 테마 id (hud.ts THEMES) — 모든 위젯의 기본 모양
  widgets?: Widget[]; // 없으면 예전 배치(attitude/heading/map/readouts)에서 만든다
  text?: HudText;
  gogglesView?: "inset" | "full"; // 고글 녹화 화면 배율: 축소(OSD 가 영상 밖 검은 여백) / 전체 100%(OSD 가 영상 위)
  attitude: Box; // 원형 계기는 픽셀상 정사각형 유지
  heading: Box; // 나침반 원형이면 정사각형, 테이프형이면 가로 띠
  map: Box;
  readouts: Box; // 속도·고도·상승률 글자 줄
  osd: OsdMask[];
}
const ASPECT = 16 / 9;
const gauge = (x: number, y: number, w: number): Box => ({ x, y, w, h: w * ASPECT });
// 기본값 = 1920x1080 기준 하단 배치 (자세계·방위계 왼쪽, 미니맵 오른쪽), 고글 OSD 는 실제 Goggles 3 녹화 기준 하단 한 줄
export const defaultLayout = (): Layout => ({
  attitude: gauge(0.01875, 0.6, 0.1229),
  heading: gauge(0.1594, 0.6, 0.1229),
  map: gauge(0.8583, 0.6, 0.1229),
  readouts: { x: 0.31, y: 0.795, w: 0.5, h: 0.04 },
  osd: [defaultOsd()],
});
// 실제 Goggles 3 녹화: 카메라 화면은 가운데 축소, OSD 글자는 하단 검은 여백 위 → 검정 제거 + 살짝 블러
export const defaultOsd = (): OsdMask => ({ x: 0, y: 0.865, w: 1, h: 0.135, shape: "rect", feather: 0.006, key: true });

export interface FlightPrefs {
  title?: string;
  instruments: boolean;
  map: boolean;
  goggles: boolean;
  top: number; // 고글 OSD 위쪽 띠 (화면 높이 비율)
  bottom: number;
}
export const defaultPrefs = (): FlightPrefs => ({ instruments: true, map: true, goggles: true, top: 0, bottom: 0.13 });

export interface GogglesLink {
  file: string; // goggles/ 안의 파일명
  offset: number; // 비행 시간 = 고글 시간 + offset (초)
  score: number;
  manual?: boolean;
  view?: "inset" | "full"; // 이 고글 녹화의 화면 배율 (자동 감지, 사용자가 바꾸면 viewManual)
  viewManual?: boolean;
}

export interface State {
  version: 1;
  overrides: Record<string, Override>;
  scores: Record<string, number>;
  videos: Record<string, VideoRecord>; // key = 2_ready / 3_uploaded 의 파일명
  remote?: Record<string, string>; // YouTube 동기화 결과: 원본 MP4 파일명 → videoId
  prefs?: Record<string, FlightPrefs>;
  goggles?: Record<string, GogglesLink[] | GogglesLink>; // flightId → 고글 연결 (클립마다 하나씩일 수 있음; 예전 형식은 단일 객체)
  layout?: Layout; // 폴더 전체에 적용되는 HUD/OSD 배치
  quota: { day: string; used: number };
}

export const emptyState = (): State => ({ version: 1, overrides: {}, scores: {}, videos: {}, quota: { day: "", used: 0 } });

export async function readState(root: FileSystemDirectoryHandle): Promise<State> {
  try {
    const f = await (await root.getFileHandle(STATE_FILE)).getFile();
    return { ...emptyState(), ...JSON.parse(await f.text()) };
  } catch {
    return emptyState();
  }
}

let writing = Promise.resolve();
export const flushState = () => writing.catch(() => {});
export function writeState(root: FileSystemDirectoryHandle, s: State) {
  const text = JSON.stringify(s, null, 2);
  writing = writing.then(async () => {
    const w = await (await root.getFileHandle(STATE_FILE, { create: true })).createWritable();
    await w.write(text);
    await w.close();
  });
  return writing;
}

export const subdir = (root: FileSystemDirectoryHandle, name: string) => root.getDirectoryHandle(name, { create: true });

export async function listFiles(dir: FileSystemDirectoryHandle) {
  const out: Record<string, FileSystemFileHandle> = {};
  for await (const [name, h] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
    if (h.kind === "file") out[name] = h as FileSystemFileHandle;
  }
  return out;
}

export async function exists(dir: FileSystemDirectoryHandle, name: string) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

// 같은 볼륨이면 move() 로 즉시 이동, 미지원이면 복사 후 삭제
export async function moveFile(from: FileSystemDirectoryHandle, name: string, to: FileSystemDirectoryHandle) {
  if (await exists(to, name)) throw new Error(`${to.name}/${name} 이미 존재`);
  const h = await from.getFileHandle(name);
  if (typeof (h as any).move === "function") {
    try {
      await (h as any).move(to);
      return;
    } catch (e) {
      if ((e as DOMException).name !== "NotSupportedError") throw e;
    }
  }
  const src = await h.getFile();
  const w = await (await to.getFileHandle(name, { create: true })).createWritable();
  await src.stream().pipeTo(w);
  await from.removeEntry(name);
}

// ---- 폴더 핸들 기억 (IndexedDB) ----
const DB = "dji-uploader";
function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) {
  return new Promise<T>((ok, err) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onerror = () => err(req.error);
    req.onsuccess = () => {
      const r = fn(req.result.transaction("kv", mode).objectStore("kv"));
      r.onsuccess = () => ok(r.result);
      r.onerror = () => err(r.error);
    };
  });
}
export const saveRoot = (h: FileSystemDirectoryHandle) => idb("readwrite", (s) => s.put(h, "root")).catch(() => {});
export const loadRoot = () => idb<FileSystemDirectoryHandle | undefined>("readonly", (s) => s.get("root")).catch(() => undefined);

// 고글 녹화 폴더 (읽기 전용, 선택 사항). null = "고글 없음"으로 정함
export const saveGogglesDir = (h: FileSystemDirectoryHandle | null) =>
  idb<unknown>("readwrite", (s) => (h ? s.put(h, "goggles") : s.delete("goggles")) as IDBRequest<unknown>).catch(() => {});
export const saveLogsDir = (h: FileSystemDirectoryHandle | null) =>
  idb<unknown>("readwrite", (s) => (h ? s.put(h, "logs") : s.delete("logs")) as IDBRequest<unknown>).catch(() => {});
export const loadLogsDir = () => idb<FileSystemDirectoryHandle | undefined>("readonly", (s) => s.get("logs")).catch(() => undefined);
export const loadGogglesDir = () => idb<FileSystemDirectoryHandle | undefined>("readonly", (s) => s.get("goggles")).catch(() => undefined);

export async function ensurePermission(h: FileSystemDirectoryHandle, mode: "read" | "readwrite" = "readwrite") {
  const opts = { mode } as const;
  if (typeof (h as any).queryPermission !== "function") return true; // OPFS (개발용 테스트 폴더)
  if ((await (h as any).queryPermission(opts)) === "granted") return true;
  return (await (h as any).requestPermission(opts)) === "granted";
}

export const linksOf = (s: State, id: string): GogglesLink[] => {
  const v = s.goggles?.[id];
  return !v ? [] : Array.isArray(v) ? v : [v];
};
export const layoutOf = (s: State): Layout => ({ ...defaultLayout(), ...s.layout });
