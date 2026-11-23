// 폴더 역할: 프로젝트 폴더의 하위 폴더 이름으로 드론 원본·고글 원본·결과 폴더를 정한다.
// 원본(드론·고글·비행기록)은 읽기만, 결과(드론 병합본·고글 병합본·HUD)에만 쓴다.
import { RAW_RE } from "./store.ts";

export type Role = "droneRaw" | "gogglesRaw" | "droneMerged" | "gogglesMerged" | "hud" | "logs";
export const ROLES: Role[] = ["droneRaw", "gogglesRaw", "droneMerged", "gogglesMerged", "hud", "logs"];
export const READONLY_ROLES: Role[] = ["droneRaw", "gogglesRaw", "logs"];
// 원본 칸(읽기 전용): 기체 raw·고글 원본·비행기록
export const isReadonlyPick = (k: string) => k === "gogglesRaw" || k === "logs" || k.endsWith(":raw");

export interface RoleGuess {
  droneRaw: string; // "." = 프로젝트 폴더 자체
  gogglesRaw: string | null;
  droneMerged: { name: string; create: boolean };
  gogglesMerged: { name: string; create: boolean };
  hud: { name: string; create: boolean };
  logs: string | null;
  legacy: string[]; // 예전 구조의 읽기 전용 검색 위치 (_sources, 3_uploaded)
  excluded: string | null; // 예전 _excluded
  gogglesExtra: string | null; // 고글 원본을 따로 정했을 때 남는 예전 goggles/
  aircraft: string[]; // 기체 폴더 (<기체>/raw 가 있는 하위 폴더). 비어 있으면 단일 기체 모드
}

const LEGACY_READY = "2_ready";

export function detectRoles(dirNames: string[], opts: { rawAtTop: boolean; externalGoggles: boolean }): RoleGuess {
  const find = (...cands: string[]) => {
    for (const c of cands) {
      const hit = dirNames.find((n) => n.toLowerCase() === c.toLowerCase());
      if (hit) return hit;
    }
    return null;
  };
  const ready = find(LEGACY_READY);
  const droneRaw = find("aircraft_raw", "drone_raw", "raw") ?? ".";
  const gog = find("google_raw", "goggles_raw", "goggles");
  const gogglesRaw = opts.externalGoggles ? null : gog;
  const gogglesExtra = opts.externalGoggles ? gog : null;
  const out = (found: string | null, fallback: string) => (found ? { name: found, create: false } : { name: fallback, create: true });
  const gogPrefix = (gogglesRaw ?? gog ?? "").toLowerCase().startsWith("google") ? "google" : "goggles";
  return {
    droneRaw,
    gogglesRaw,
    droneMerged: out(find("aircraft_merged", "drone_merged") ?? ready, droneRaw.toLowerCase().startsWith("aircraft") ? "aircraft_merged" : "drone_merged"),
    gogglesMerged: out(find("google_merged", "goggles_merged") ?? ready, `${gogPrefix}_merged`),
    hud: out(find("hud") ?? ready, "hud"),
    logs: find("FlightRecords"),
    legacy: ["_sources", "3_uploaded"].map((n) => find(n)).filter((n): n is string => !!n),
    excluded: find("_excluded"),
    gogglesExtra,
    aircraft: [],
  };
}

// 기체 폴더: 프로젝트 바로 아래에서 raw/ 를 가진 폴더 (고글·숨김·예전 구조 이름 제외)
export function detectAircraft(sub: { name: string; hasRaw: boolean }[]): string[] {
  return sub
    .filter((x) => x.hasRaw && !/^(goggles|google)/i.test(x.name) && !/^[._]/.test(x.name))
    .map((x) => x.name)
    .sort();
}

// 예전 버전의 역할 키(droneRaw·droneMerged·hud)를 단일 기체(default) 키로
const OLD_KEYS: Record<string, string> = { droneRaw: "aircraft:default:raw", droneMerged: "aircraft:default:merged", hud: "aircraft:default:hud" };
export function migratePicks(p: Record<string, FileSystemDirectoryHandle | null>): RolePicks {
  const out: Record<string, FileSystemDirectoryHandle | null> = {};
  for (const [k, v] of Object.entries(p)) out[OLD_KEYS[k] ?? k] = v;
  return out as RolePicks;
}

// ---------- 브라우저 ----------
export interface AircraftDirs {
  id: string; // 기체 폴더 이름, 단일 기체 모드는 "default"
  raw: FileSystemDirectoryHandle; // 읽기 전용
  merged: FileSystemDirectoryHandle;
  hud: FileSystemDirectoryHandle;
}
export interface ProjectDirs {
  project: FileSystemDirectoryHandle;
  aircraft: AircraftDirs[];
  gogglesRaw: FileSystemDirectoryHandle | null;
  gogglesExtra: FileSystemDirectoryHandle | null;
  gogglesMerged: FileSystemDirectoryHandle;
  logs: FileSystemDirectoryHandle | null;
  legacy: FileSystemDirectoryHandle[];
  excluded: FileSystemDirectoryHandle | null;
}
export type AircraftSlot = "raw" | "merged" | "hud";
export type PickKey = "gogglesRaw" | "gogglesMerged" | "logs" | `aircraft:${string}:${AircraftSlot}`;
export type RolePicks = Partial<Record<PickKey, FileSystemDirectoryHandle | null>>; // 사용자가 칸에서 바꾼 것 (null = 없음)
export const pickKey = (id: string, slot: AircraftSlot): PickKey => `aircraft:${id}:${slot}`;

async function children(dir: FileSystemDirectoryHandle) {
  const dirs: { name: string; hasRaw: boolean }[] = [];
  let rawAtTop = false;
  for await (const [name, h] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
    if (h.kind === "directory") {
      const hasRaw = await (h as FileSystemDirectoryHandle).getDirectoryHandle("raw").then(() => true, () => false);
      dirs.push({ name, hasRaw });
    } else if (RAW_RE.test(name) && /\.mp4$/i.test(name)) rawAtTop = true;
  }
  return { dirs, rawAtTop };
}

export async function guessFor(project: FileSystemDirectoryHandle, externalGoggles: boolean): Promise<RoleGuess> {
  const { dirs, rawAtTop } = await children(project);
  return { ...detectRoles(dirs.map((d) => d.name), { rawAtTop, externalGoggles }), aircraft: detectAircraft(dirs) };
}

// "시작"을 누를 때만 부른다: create 인 결과 폴더는 여기서 만든다.
// 필수 역할(드론 원본·결과 3종)은 null 을 골라도 추정값을 쓰고, 선택 역할(고글 원본·비행기록)은 null = 없음
export async function resolveDirs(project: FileSystemDirectoryHandle, guess: RoleGuess, picks: RolePicks): Promise<ProjectDirs> {
  const sub = (name: string, create = false) => project.getDirectoryHandle(name, { create });
  const out = (g: { name: string; create: boolean }) => sub(g.name, g.create);
  const optional = async (r: PickKey, name: string | null) => (r in picks ? picks[r] ?? null : name ? sub(name) : null);
  const gogglesRaw = await optional("gogglesRaw", guess.gogglesRaw);
  // 고글 원본을 따로 정했으면 예전 goggles/ 는 추가 읽기 위치로
  const extraName = guess.gogglesExtra ?? (picks.gogglesRaw && guess.gogglesRaw ? guess.gogglesRaw : null);
  let gogglesExtra = extraName ? await sub(extraName) : null;
  if (gogglesExtra && gogglesRaw && (await gogglesExtra.isSameEntry(gogglesRaw).catch(() => false))) gogglesExtra = null;
  // 기체별 raw·merged·hud. 기체 폴더가 없으면 단일 기체(default) = 예전 추정 규칙
  const aircraft: AircraftDirs[] = [];
  if (guess.aircraft.length) {
    for (const id of guess.aircraft) {
      const base = await sub(id);
      aircraft.push({
        id,
        raw: picks[pickKey(id, "raw")] ?? (await base.getDirectoryHandle("raw")),
        merged: picks[pickKey(id, "merged")] ?? (await base.getDirectoryHandle("merged", { create: true })),
        hud: picks[pickKey(id, "hud")] ?? (await base.getDirectoryHandle("hud", { create: true })),
      });
    }
  } else {
    aircraft.push({
      id: "default",
      raw: picks[pickKey("default", "raw")] ?? (guess.droneRaw === "." ? project : await sub(guess.droneRaw)),
      merged: picks[pickKey("default", "merged")] ?? (await out(guess.droneMerged)),
      hud: picks[pickKey("default", "hud")] ?? (await out(guess.hud)),
    });
  }
  return {
    project,
    aircraft,
    gogglesRaw,
    gogglesExtra,
    gogglesMerged: picks.gogglesMerged ?? (await out(guess.gogglesMerged)),
    logs: await optional("logs", guess.logs),
    legacy: await Promise.all(guess.legacy.map((n) => sub(n))),
    excluded: guess.excluded ? await sub(guess.excluded) : null,
  };
}

// 칸의 "101개" 표시: 이름이 맞는 파일 수 (depth 단계 아래까지)
export async function countMedia(dir: FileSystemDirectoryHandle, re: RegExp, depth = 0): Promise<number> {
  let n = 0;
  for await (const [name, h] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
    if (h.kind === "file" && re.test(name)) n++;
    else if (h.kind === "directory" && depth > 0 && !name.startsWith(".")) n += await countMedia(h as FileSystemDirectoryHandle, re, depth - 1);
  }
  return n;
}
