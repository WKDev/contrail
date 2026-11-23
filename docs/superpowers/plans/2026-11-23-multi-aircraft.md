# 기체 여러 대 + 공용 고글 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 한 프로젝트에 기체별 하위 폴더(`<기체>/{raw,merged,hud}`)와 공용 고글 폴더를 두고, 기체별로 묶고·배치하고, 고글 녹화의 주인 기체를 가려낸다.

**Architecture:** `roles.ts` 가 기체 목록을 찾고 `ProjectDirs.aircraft[]` 로 넘긴다. `library.ts` 는 기체별로 스캔·묶기, `assign.ts`(새, 순수)는 고글 녹화의 주인 기체와 시계 오차를 계산한다. 상태는 `version: 1` 그대로 `layouts`·`clock`·`gogglesOwner` 를 추가. 기체 폴더가 없으면 지금(단일 기체) 동작과 같다.

**Tech Stack:** Preact 11, TypeScript 7, File System Access API, `node --test`

**Spec:** `docs/superpowers/specs/2026-11-23-multi-aircraft-design.md`

## Global Constraints

- 원본(기체 `raw/`, `goggles_raw/`, 비행기록, 예전 `_sources`/`3_uploaded`/`_excluded`)은 앱이 옮기거나 지우지 않는다. 쓰기는 기체 `merged/`·`hud/`, `goggles_merged/` (고글 원본은 "고글 영상 추가" 때만).
- 상태 `version: 1` 유지, 기존 키 의미 불변. 새 키: `layouts`, `clock`, `gogglesOwner`, `VideoRecord.aircraft`.
- 기체 폴더가 하나도 없으면 단일 기체 모드, 기체 id `default`, 이전 설계 동작 그대로 (기존 테스트 전부 통과).
- 판정 상수: ambiguous = 2등 겹침 ≥ 1등의 80%, 화면 점수 차 ≥ 0.1 이어야 자동 배정, 시계 오차 학습 = 점수 ≥ 0.6, |오차| < 3초는 무시.
- 새 문구 ko/en 실제 문구, ja/zh/es 는 영어.

## Review Focus

1. 두 기체 클립이 1초 간격 — 한 비행으로 묶이지 않음 → Task 2 `"기체가 다르면 시간이 붙어 있어도 따로 묶는다"`.
2. 고글 녹화가 같은 기체 비행 3개에 시간대별로 연결된 실제 상태 — 그대로 유지 → Task 3 `"연결된 녹화는 연결된 비행의 기체가 주인"`.
3. 시계가 크게 틀린 기체 — 학습 전엔 후보 없음, 학습 후 후보로 잡힘 → Task 3 `"시계 오차를 적용하면 후보가 된다"`.
4. 비행 데이터 없는 기체 — HUD 기본 계기·지도 끔, 고글 OSD 만 → Task 4 `"비행 데이터 없는 기체는 계기·지도 기본 끔"`.
5. 이전 후 Avata 2 기존 결과 — 병합본 완료·고글 연결 유지 → Task 7 실제 폴더 확인(파일 수·상태 키 수 비교).

---

### Task 1: 기체 폴더 인식 (`roles.ts`)

**Files:** Modify `src/roles.ts`; Test `test/roles.test.ts`

**Interfaces — Produces:**
```ts
export interface AircraftDirs { id: string; raw: FileSystemDirectoryHandle; merged: FileSystemDirectoryHandle; hud: FileSystemDirectoryHandle }
export interface ProjectDirs { project; aircraft: AircraftDirs[]; gogglesRaw; gogglesExtra; gogglesMerged; logs; legacy; excluded } // droneRaw/droneMerged/hud 제거
export type PickKey = "gogglesRaw" | "gogglesMerged" | "logs" | `aircraft:${string}:${"raw" | "merged" | "hud"}`;
export type RolePicks = Partial<Record<PickKey, FileSystemDirectoryHandle | null>>;
export function detectAircraft(sub: { name: string; hasRaw: boolean }[]): string[]; // raw/ 가진 하위 폴더 이름 (goggles*/google* 제외), 정렬
export function migratePicks(p: Record<string, FileSystemDirectoryHandle | null>): RolePicks; // droneRaw→aircraft:default:raw 등
```
- [ ] 실패 테스트: `"raw 를 가진 하위 폴더가 기체"` (`[{avata2,true},{pavopro2,true},{goggles_raw,false},{docs,false}]` → `["avata2","pavopro2"]`), `"고글 이름은 기체가 아님"` (`{goggles,true}` 제외), `"예전 picks 이전"` (`{droneRaw:h, hud:h2, gogglesRaw:g}` → `{ "aircraft:default:raw": h, "aircraft:default:hud": h2, gogglesRaw: g }`).
- [ ] 구현. `resolveDirs`: 기체가 있으면 기체마다 `raw`(필수)·`merged`/`hud`(create), 공용 `goggles_merged`(create, 없으면 기존 추정 규칙). 기체가 없으면 기존 `detectRoles` 결과로 `aircraft:[{id:"default", raw, merged, hud}]`. `guessFor` 는 하위 폴더마다 `raw` 존재 여부를 본다.
- [ ] `pnpm test` → 통과 (기존 roles 테스트 유지). 커밋 `feat: detect aircraft folders`.

### Task 2: 기체별 스캔·묶기 (`library.ts`, `plan.ts`)

**Files:** Modify `src/library.ts`, `src/plan.ts` (`Clip.aircraft?: string`); Test `test/library.test.ts`

**Interfaces — Produces:** `FileRef.aircraft: string`; `Flight.aircraft: string`; `Index.aircraft: { id: string; model?: string }[]`; `Library.pendingClips`/`decisions` = 기체별 결과를 이어 붙인 것 (첫 클립의 decision 은 이웃 없음).
- [ ] 실패 테스트 (기존 `dirs()` 헬퍼를 `aircraft:[{id:"avata2",...}]` 로 바꾸고 기존 테스트 전부 유지):
  - `"기체가 다르면 시간이 붙어 있어도 따로 묶는다"`: avata2 raw `A`(460초), pavopro2 raw `B`(1초 뒤) → 비행 2개, `aircraft` 가 각각.
  - `"기록의 기체는 결과 파일이 있는 기체"`: pavopro2 merged 에 `X_merged.MP4` + 기록(aircraft 없음) → `flight.aircraft === "pavopro2"`.
  - `"기체 모델을 읽는다"`: fake 파일 앞부분에 `"DJI O4P"` 가 있으면 `idx.aircraft[0].model === "O4P"` (fakeFile 에 `slice().arrayBuffer()` 지원 추가).
- [ ] 구현: 스캔 위치 = 기체마다 raw/merged/hud + 공용 + legacy/excluded(단일 모드면 default 기체 소속). 같은 이름이 다른 기체에 또 있으면 키 `<id>/<name>`. 묶기는 기체별 `decide`/`groupClips`. 기록 기체 = `rec.aircraft` ?? 결과 파일 기체 ?? 첫 원본 기체 ?? 첫 기체. 모델 = 기체 첫 원본 MP4 앞 2MB 에서 `/DJI ([A-Za-z0-9 ]{2,20})\0/` 중 `FC` 로 시작하지 않는 첫 값.
- [ ] `pnpm test` → 통과. 커밋 `feat: scan and group per aircraft`.

### Task 3: 고글 주인 기체·시계 오차 (`assign.ts`)

**Files:** Create `src/assign.ts`; Test `test/assign.test.ts`

**Interfaces — Produces:**
```ts
export interface Owner { aircraft?: string; by: "linked" | "manual" | "time" | "ambiguous" | "none"; candidates: string[] }
export function ownerOfGoggles(
  goggles: { name: string; start: number; duration: number }[],
  flights: { id: string; aircraft: string; start: number; end: number; day: string }[],
  links: Record<string, { file: string }[]>,          // flightId → 연결
  clockErr: (aircraft: string, day: string) => number, // 초, 고글 시각에 더함
  manual: Record<string, string>,                       // 고글 파일 → 기체
): Map<string, Owner>;
export function learnClockErr(coarse: number, offset: number, score: number): number | null; // score<0.6 또는 |offset-coarse|<3 → null, 아니면 offset-coarse
export function medianErr(list: number[]): number;
export const shiftGoggles = <T extends { start: number }>(g: T, errSec: number): T => ({ ...g, start: g.start + errSec * 1000 });
```
- [ ] 실패 테스트: `"시간 겹침이 큰 기체가 주인"`, `"연결된 녹화는 연결된 비행의 기체가 주인"` (시간상 다른 기체와 더 겹쳐도), `"사용자 선택이 최우선"`, `"비슷하게 겹치면 ambiguous, 후보 두 기체"`, `"시계 오차를 적용하면 후보가 된다"` (오차 0 이면 `none`, −120초 적용하면 `time`), `"learnClockErr 기준"` (`(10, 10.6, 0.9)→null`, `(10, -110, 0.8)→-120`, `(10, -110, 0.5)→null`).
- [ ] 구현 (겹침 = 고글 구간 [start+err, +duration] 과 비행 [start,end] 교집합 초, 기체별 합).
- [ ] `pnpm test` → 통과. 커밋 `feat: goggles owner aircraft and clock error`.

### Task 4: 상태 — 기체별 배치·기본값 (`store.ts`)

**Files:** Modify `src/store.ts`; Test `test/store.test.ts`

**Interfaces — Produces:** `State.layouts?: Record<string, Layout>`, `State.clock?: Record<string, Record<string, number[]>>` (기체 → 날짜 → 오차들), `State.gogglesOwner?: Record<string, string>`, `VideoRecord.aircraft?: string`; `layoutOf(s: State, aircraft?: string): Layout`; `prefsDefault(hasTelemetry: boolean): FlightPrefs`.
- [ ] 실패 테스트: `"기체 배치가 있으면 그것, 없으면 예전 layout"`, `"비행 데이터 없는 기체는 계기·지도 기본 끔"` (`prefsDefault(false)` → instruments/map false, goggles true).
- [ ] 구현. 커밋 `feat: per-aircraft layout and defaults in state`.

### Task 5: 앱 컨트롤러 (`app.tsx`)

**Files:** Modify `src/app.tsx`

**Interfaces — Produces (AppCtx):** `layoutFor(aircraft: string): Layout`, `setLayout(l: Layout | null, aircraft: string)`, `aircraftOf(f: Flight)`, `hasTelemetry: Record<string, boolean>`, `ownerOf(file: string): Owner`, `setGogglesOwner(file: string, aircraft: string | null)`, `linkGogglesTo(file: string, flightId: string)` (넓은 검색 ±600초로 맞춤), `aircraftFilter: string | null`, `setAircraftFilter`.
- [ ] 쓰기 위치: `doMerge` → `dirOf(f).merged`, `doOverlay` → `dirOf(f).hud`, 텔레메트리 json·`.part` 정리도 기체별. `outputHandle(name, f)` 는 그 기체 merged 먼저. 기록 저장 시 `aircraft: f.aircraft`.
- [ ] `gogglesOf(f)`: 후보 = `ownerOf(g).aircraft === f.aircraft` 인 녹화 중 `matchGogglesForClips(f.clips, list.map(g => shiftGoggles(g, err)))`. `syncCore` 도 보정된 고글 시작 시각 사용, 결과로 `learnClockErr` → `state.clock[aircraft][day]` 에 추가.
- [ ] ② 단계: 먼저 `ambiguous` 녹화마다 후보 기체별 최대 겹침 비행과 `syncGoggles` → 점수 차 ≥ 0.1 이면 `gogglesOwner` 저장, 아니면 알림 `gog.ownerAsk`. 그다음 기존 sync/merge.
- [ ] `prefsOf(id)`: 기본값 = `prefsDefault(hasTelemetry[aircraft] ?? true)`. `hasTelemetry` = 기체 첫 원본 클립 `readTelemetry` 에 유효 lat 또는 attitude 가 있는지 (스캔 후 effect, 기체별 1회 캐시).
- [ ] `layoutOf(stateRef.current, f.aircraft)` in doOverlay. `setLayout(l, aircraft)` → `layouts[aircraft]`.
- [ ] `pnpm build` 은 Task 6 과 함께 녹색. 커밋 `feat: per-aircraft writes, goggles owner, clock learning`.

### Task 6: 화면

**Files:** Modify `src/ui/Setup.tsx`, `src/ui/Shell.tsx`, `src/ui/Flights.tsx`, `src/ui/Views.tsx`, `src/ui/Project.tsx`, `src/styles.css`, `src/i18n.ts`, locales
- [ ] Setup: 기체마다 한 줄 `[원본] → [① 병합본] → [③ HUD]` (모델 표시), 공용 줄 `[고글 원본] → [② 고글 병합본]`, "기체 추가" (이름 입력 → 프로젝트에 `<이름>/raw` 만들기, 이름 규칙 `^[a-z0-9_-]{1,32}$`). 기체가 없는 단일 모드는 지금 화면 그대로(기체 1줄).
- [ ] Shell 사이드바: 기체 필터 목록(이름 · 모델 · 비행 수, "전체"), 폴더 상태는 기체별 묶음. Flights 필터·카드에 기체 칩(기체 2개 이상일 때만).
- [ ] Views 고글 화면: 행마다 주인 기체 칩(방식 표시), `ambiguous`/`none` 이면 기체 선택 + "비행 골라 맞추기"(→ `linkGogglesTo`).
- [ ] Project: HUD·고글 탭 배치 = `layoutFor(f.aircraft)`; 비행 데이터 없는 기체는 HUD 탭에 `hud.noTelemetry` 안내.
- [ ] 문구: `aircraft.all`, `aircraft.add`, `aircraft.name`, `aircraft.nameRule`, `aircraft.flights`, `gog.owner`, `gog.ownerTime`, `gog.ownerLinked`, `gog.ownerManual`, `gog.ownerAmbiguous`, `gog.ownerAsk`, `gog.pickFlight`, `hud.noTelemetry`.
- [ ] `pnpm build && pnpm test` → 통과. dev 서버 첫 화면 콘솔 오류 없음. 커밋 `feat: multi-aircraft setup, filters and goggles owner UI`.

### Task 7: 기존 데이터 이전 + 문서

**Files:** Create `scratchpad/migrate_archive.py` (저장소 밖), Modify `docs/ARCHITECTURE.md`, `README.md`, `README.ko.md`, `../README.md`(dji_uploader 작업 공간)
- [ ] 이전 전 기록: 각 폴더 파일 수·총 바이트, 두 상태 파일 키 수.
- [ ] 상태 합치기 → 루트 `dji_state.json` (videos/prefs/remote 루트, goggles·scores·overrides 합집합, `layouts.avata2` = 안쪽 layout, 기존 `layout` 유지), 안쪽 파일은 `dji_state.aircraft_raw-backup.json` 으로.
- [ ] 빈 예전 폴더 `rmdir`, `Avata2`→`DroneArchive`, `aircraft_raw`→`avata2/raw`, `aircraft_merged`→`avata2/merged`, `google_raw`→`goggles_raw`, `pavopro2/DJI_*`→`pavopro2/raw/`.
- [ ] 이전 후 같은 숫자 비교 (파일 수·바이트 동일).
- [ ] 문서 갱신 (폴더 구조 = 기체별, 고글 주인 판정, 기체별 배치). 커밋 `docs: multi-aircraft archive layout`.
