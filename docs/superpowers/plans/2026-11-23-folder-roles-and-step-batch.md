# 폴더 역할 분리 + 단계별 일괄 처리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 원본은 읽기만 하고 결과물은 역할별 폴더에 쌓으며, ① 드론 병합 ② 고글(맞춤+병합) ③ HUD 를 단계마다 일괄 실행한다.

**Architecture:** 순수 함수 두 개를 새로 둔다 — `roles.ts`(폴더 이름 → 역할 추정)와 `steps.ts`(비행 → 단계 상태·할 일). `library.ts` 는 역할별 폴더를 읽고 "결과 파일이 있으면 완료"로 판정한다. `app.tsx` 의 작업 함수는 원본을 옮기지 않고 결과 폴더에만 쓰며, 단계 실행기 `runStep` 이 기존 `runAll` 을 대체한다. UI 는 흐름도형 설정 화면 + 라이브러리 단계 줄.

**Tech Stack:** Preact 11, TypeScript 7, Vite 8, File System Access API, `node --test` (strip-types)

**Spec:** `docs/superpowers/specs/2026-11-23-folder-roles-and-step-batch-design.md`

## Global Constraints

- 원본 폴더(드론 원본·고글 원본·비행기록)의 파일은 어떤 작업도 옮기거나 지우지 않는다. `moveFile`/`removeEntry` 는 결과 폴더(드론 병합본·고글 병합본·HUD)에서만.
- 상태 파일 형식 `version: 1` 유지, 위치 = 프로젝트 폴더 `dji_state.json`.
- 결과 파일 이름 유지: `<id>_merged.MP4`, `<id>_goggles.MP4`, `<id>_hud.MP4`, `<name>.telemetry.json`, 임시 `*.part`.
- i18n: 새 키는 `src/i18n.ts` 의 ko·en 에 실제 문구, `src/locales/{ja,zh,es}.ts` 에는 영어 문구를 그대로 (테스트 "모든 언어: 키와 {자리표시자}가 영어와 같다" 통과 필수).
- 폴더를 열 때 고글 자동 맞춤 없음. 맞춤은 ② 단계 또는 비행 화면 고글 탭에서만.
- 지도 실패 문구에 `location.origin` 을 넣어 "키의 웹사이트 제한에 이 주소 추가"를 안내.

## Review Focus

1. **Avata2 첫 열기** — `aircraft_merged` 의 병합본 7개(기록 6 + 기록 없는 `..._0017_D_merged.MP4`)가 모두 완료, 그 원본 클립은 ① 대상에 없어야 함 → Task 2 테스트 `"원본이 남아 있어도 기록된 병합본이 있으면 완료"`, `"기록 없는 병합본은 프레임 수가 맞으면 받아들임"`.
2. **예전 구조 폴더**(루트 원본 + `2_ready/` + `_sources/`) — 결과가 그대로 보이고 아무것도 다시 병합하지 않음 → Task 1 `"예전 구조"`, Task 2 `"_sources 에 옮겨진 원본도 찾는다"`.
3. **결과 파일이 사라진 업로드 기록** — 목록에서 사라지지 않고 "파일 없음" → Task 2 `"결과 파일도 원본 MP4 도 없으면 missing"`.
4. **고글 원본 폴더 SD 카드가 빠짐** — 앱은 열리고 고글 칸만 "다시 연결", ② 대상 0 → Task 2 `"고글 폴더를 못 읽어도 스캔은 계속"`.
5. **전부 순서대로 중 ① 실패한 비행** — ③ 에서 그 비행은 "병합 먼저"로 세고 건너뜀 → Task 3 `"드론 병합이 안 끝난 비행은 HUD blocked"`.

---

## File Structure

| 파일 | 책임 |
|---|---|
| Create `src/roles.ts` | `detectRoles` (순수), `openProject`/`countMedia` (브라우저) — 폴더 역할 |
| Create `src/steps.ts` | `stepsOf`, `stepTodo`, `isPendingView` (순수) — 단계 상태 |
| Create `src/ui/Setup.tsx` | 흐름도형 첫 화면 + 사이드바에서 다시 여는 폴더 설정 |
| Create `src/ui/StepBar.tsx` | 라이브러리 위 단계 줄 |
| Modify `src/library.ts` | `Dirs`/`Index` 새 모양, `scanIndex`, `buildLibrary` 완료 판정 |
| Modify `src/store.ts` | 프로젝트 핸들 저장(IndexedDB), 예전 키 이전, `DIRS` 정리 |
| Modify `src/app.tsx` | 작업 함수 쓰기 위치, `runStep`, 자동 맞춤 제거, ctx |
| Modify `src/map.ts`, `src/render.ts`, `src/ui/Project.tsx` | 지도 오류 상태·표시 |
| Modify `src/ui/Shell.tsx`, `Flights.tsx`, `Views.tsx`, `Project.tsx` | 새 ctx 사용, 경로 표시 |
| Modify `src/i18n.ts`, `src/locales/*.ts` | 문구 |
| Test `test/roles.test.ts`, `test/library.test.ts`, `test/steps.test.ts`, `test/map.test.ts` | |
| Modify `docs/ARCHITECTURE.md`, `README.ko.md`, `README.md` | 폴더 구조·일괄 처리 설명 |

---

### Task 1: 폴더 역할 추정 (`roles.ts`)

**Files:**
- Create: `src/roles.ts`
- Test: `test/roles.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Role = "droneRaw" | "gogglesRaw" | "droneMerged" | "gogglesMerged" | "hud" | "logs";
  export interface RoleGuess {
    droneRaw: string;                       // "." = 프로젝트 폴더 자체
    gogglesRaw: string | null;
    droneMerged: { name: string; create: boolean };
    gogglesMerged: { name: string; create: boolean };
    hud: { name: string; create: boolean };
    logs: string | null;
    legacy: string[];                       // 읽기 전용 검색 위치: "_sources" | "3_uploaded" 중 있는 것
    excluded: string | null;                // "_excluded" 가 있으면
    gogglesExtra: string | null;            // 고글 원본을 따로 정했을 때 남는 예전 "goggles"
  }
  export function detectRoles(dirNames: string[], opts: { rawAtTop: boolean; externalGoggles: boolean }): RoleGuess;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
test("Avata2 구조", () => {
  const g = detectRoles(["aircraft_raw", "google_raw", "aircraft_merged"], { rawAtTop: false, externalGoggles: false });
  assert.equal(g.droneRaw, "aircraft_raw");
  assert.equal(g.gogglesRaw, "google_raw");
  assert.deepEqual(g.droneMerged, { name: "aircraft_merged", create: false });
  assert.deepEqual(g.gogglesMerged, { name: "google_merged", create: true });
  assert.deepEqual(g.hud, { name: "hud", create: true });
  assert.equal(g.logs, null);
});
test("예전 구조: 원본이 맨 위, 결과는 2_ready", () => {
  const g = detectRoles(["2_ready", "3_uploaded", "_sources", "_excluded", "goggles"], { rawAtTop: true, externalGoggles: true });
  assert.equal(g.droneRaw, ".");
  assert.deepEqual([g.droneMerged, g.gogglesMerged, g.hud].map((x) => x.name), ["2_ready", "2_ready", "2_ready"]);
  assert.deepEqual(g.legacy.sort(), ["3_uploaded", "_sources"]);
  assert.equal(g.excluded, "_excluded");
  assert.equal(g.gogglesRaw, null);     // 따로 연결한 고글 폴더가 역할을 가져감
  assert.equal(g.gogglesExtra, "goggles");
});
test("대소문자 무시, 목록 순서대로 첫 번째", () => {
  const g = detectRoles(["Drone_Raw", "RAW", "Goggles_Raw", "FlightRecords"], { rawAtTop: false, externalGoggles: false });
  assert.equal(g.droneRaw, "Drone_Raw");
  assert.equal(g.gogglesRaw, "Goggles_Raw");
  assert.deepEqual(g.droneMerged, { name: "drone_merged", create: true });
  assert.deepEqual(g.gogglesMerged, { name: "goggles_merged", create: true });
  assert.equal(g.logs, "FlightRecords");
});
test("아무것도 없으면 프로젝트 폴더가 원본", () => {
  const g = detectRoles([], { rawAtTop: false, externalGoggles: false });
  assert.equal(g.droneRaw, ".");
  assert.deepEqual(g.droneMerged, { name: "drone_merged", create: true });
});
```

- [ ] **Step 2: Run** `node --experimental-strip-types --test test/roles.test.ts` → FAIL (module not found)

- [ ] **Step 3: Implement `detectRoles`**

규칙 (spec §1): 드론 원본 `aircraft_raw`→`drone_raw`→`raw`, 없으면 `"."`. 고글 원본 `google_raw`→`goggles_raw`→`goggles` (단 `externalGoggles` 면 null 이고 찾은 `goggles` 는 `gogglesExtra`). 드론 병합본 `aircraft_merged`→`drone_merged`→`2_ready`. 고글 병합본 `google_merged`→`goggles_merged`→(`2_ready` 있으면)`2_ready`. HUD `hud`→(`2_ready` 있으면)`2_ready`. 새로 만들 이름: 드론 원본 이름이 `aircraft` 로 시작하면 `aircraft_merged` 아니면 `drone_merged`; 고글 원본 이름이 `google` 로 시작하면 `google_merged` 아니면 `goggles_merged`; HUD `hud`. 반환 이름은 실제 폴더의 원래 대소문자.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Add browser helpers in the same file** (테스트 없음, Task 5 에서 사용)
  ```ts
  export interface ProjectDirs { project: FileSystemDirectoryHandle; droneRaw: FileSystemDirectoryHandle; gogglesRaw: FileSystemDirectoryHandle | null; gogglesExtra: FileSystemDirectoryHandle | null;
    droneMerged: FileSystemDirectoryHandle; gogglesMerged: FileSystemDirectoryHandle; hud: FileSystemDirectoryHandle; logs: FileSystemDirectoryHandle | null;
    legacy: FileSystemDirectoryHandle[]; excluded: FileSystemDirectoryHandle | null; }
  export type RolePicks = Partial<Record<Role, FileSystemDirectoryHandle | null>>; // 사용자가 칸에서 바꾼 것 (null = 없음)
  export async function guessFor(project: FileSystemDirectoryHandle, externalGoggles: boolean): Promise<RoleGuess>; // 하위 폴더 이름 + 맨 위 DJI_*.MP4 유무
  export async function resolveDirs(project: FileSystemDirectoryHandle, guess: RoleGuess, picks: RolePicks): Promise<ProjectDirs>; // create:true 인 것만 getDirectoryHandle(create)
  export async function countMedia(dir: FileSystemDirectoryHandle, re: RegExp, depth?: number): Promise<number>; // 칸의 "101개" 표시
  ```
  `resolveDirs` 는 "시작"을 누를 때만 호출한다 (spec: 새 폴더는 시작 때 만듦).

- [ ] **Step 6: Commit** `feat: detect folder roles from project subfolders`

---

### Task 2: 역할별 스캔 + 완료 판정 (`library.ts`)

**Files:**
- Modify: `src/library.ts` (`Dirs`, `DirKey`, `openDirs` 삭제, `scanIndex`, `buildLibrary`, `Flight`)
- Test: `test/library.test.ts` (가짜 핸들: `{ kind, name, entries(), getFile(), getDirectoryHandle() }` 를 만드는 작은 헬퍼, `mediaInfo` 대신 주입)

**Interfaces:**
- Consumes: `ProjectDirs` (Task 1)
- Produces:
  ```ts
  export type Dirs = ProjectDirs;
  export type DirKey = "raw" | "excluded" | "merged" | "gmerged" | "hud" | "legacy";
  // Index: 기존 필드 유지, gogglesExt → gogglesState: "none" | "ok" | "missing", logsExt → logsState
  export interface Flight { /* 기존 + */ missing?: boolean; synthetic?: boolean } // status: "pending" = 클립 2개 이상 & 병합 결과 없음, 그 외 "done"
  export interface Library { /* 기존 + */ adopt: { name: string; rec: VideoRecord }[] }
  export async function buildLibrary(idx: Index, st: State, s: Settings, info?: (f: File) => Promise<{ duration: number; frames: number }>): Promise<Library>;
  ```

- [ ] **Step 1: Write the failing tests** (모두 `buildLibrary(await scanIndex(fakeDirs), state, DEFAULT_SETTINGS, fakeInfo)`)

  - `"원본이 남아 있어도 기록된 병합본이 있으면 완료"`: raw 에 `A_0014.MP4`,`A_0015.MP4`, merged 에 `A_0014_merged.MP4`, `state.videos["A_0014_merged.MP4"] = {sources:[둘]}` → flights 1개, `status === "done"`, `output.ref.dir === "merged"`, `pendingClips.length === 0`.
  - `"기록 없는 병합본은 프레임 수가 맞으면 받아들임"`: raw 두 클립(프레임 100+200, 이어붙임 후보로 묶이게 간격 1초·첫 클립 460초), merged 에 `<첫 stem>_merged.MP4`(프레임 300), 기록 없음 → `status "done"`, `adopt.length === 1`, `adopt[0].rec.sources` = 두 클립. 프레임 299 면 `status "pending"`, `adopt.length === 0`.
  - `"클립 하나짜리 비행은 원본이 결과"`: raw `B.MP4` 하나, 기록 없음 → `status "done"`, `synthetic === true`, `output.name === "B.MP4"`, `output.ref.dir === "raw"`.
  - `"결과 파일도 원본 MP4 도 없으면 missing"`: `state.videos["C.MP4"] = {sources:["C.MP4"], youtubeId:"x"}`, 파일 없음 → flight 1개, `missing === true`, `youtubeId === "x"`.
  - `"결과 파일은 없고 원본은 있으면 대기"`: `state.videos["D_merged.MP4"]` 기록 + raw 에 두 원본, merged 비어 있음 → `status "pending"`.
  - `"_sources 에 옮겨진 원본도 찾는다"`: legacy `_sources` 에 원본, `2_ready` 에 병합본+기록 → `status "done"`, `clips[0].size > 0`.
  - `"_excluded 의 원본은 제외로 다시 읽는다"`: excluded 에 `E.MP4` → `excluded` 목록에 `{name:"E.MP4", dir:"excluded"}`, `overrides.E.MP4.excluded === false` 를 주면 대기 비행으로 돌아옴.
  - `"고글 폴더를 못 읽어도 스캔은 계속"`: `gogglesRaw.entries()` 가 throw → `idx.gogglesState === "missing"`, flights 정상.
  - `"HUD·고글 병합본은 해당 폴더에서 찾는다"`: hud 에 `X_hud.MP4` + `variant:"hud"` 기록 → `flight.overlay.ref.dir === "hud"`.

- [ ] **Step 2: Run** `node --experimental-strip-types --test test/library.test.ts` → FAIL

- [ ] **Step 3: Implement**
  - `scanIndex`: 파일 위치 = raw(`droneRaw`), excluded, merged(`droneMerged`), gmerged(`gogglesMerged`), hud, legacy(각 legacy 폴더). 같은 핸들이 여러 역할이면(예전 구조 `2_ready` 3역할, 또는 `droneRaw === project`) 한 번만 읽고 키는 앞의 것. 고글: `gogglesRaw`(3단계 아래까지) + `gogglesExtra`, 같은 이름은 `gogglesRaw` 우선. 고글/비행기록 폴더 읽기 실패는 상태만 `"missing"`. 드론 원본 안 `FlightRecords/` 검색은 유지.
  - `buildLibrary` 순서: (1) 기록 중 variant 없는 것 → 결과 파일 위치 찾기(idx.files 아무 dir). 있으면 완료 비행, 그 `sources` 를 "사용된 원본"에 추가. 없는데 원본 MP4 가 전부 raw/legacy 에 있으면 무시(대기로 흘러감), 아니면 `missing` 완료 비행. (2) raw + excluded 의 원본 MP4 중 사용된 원본이 아닌 것 → `decide`/`groupClips`. excluded 폴더 원본은 `overrides[name]?.excluded ?? true` 로 덮어 넣은 effective overrides 로 판정. (3) 묶음: 클립 1개면 `status "done"`, `synthetic`, record = `{sources:[name], title: defaultTitle(start), start, duration, clipDurations:[duration]}`. 2개 이상이고 merged 에 `<id>_merged.MP4` 가 기록 없이 있으면 `info()` 프레임 합 비교 → 같으면 done + `adopt` 에 추가. (4) overlay/gogglesOut 매칭은 기존 그대로.
  - `idx.sizes` 는 MP4 전부(기존 그대로).

- [ ] **Step 4: Run** `pnpm test` → 새 테스트 PASS, 기존 PASS

- [ ] **Step 5: Commit** `feat: role-based scan, done = result file exists`

---

### Task 3: 단계 상태 (`steps.ts`)

**Files:**
- Create: `src/steps.ts`
- Test: `test/steps.test.ts`

**Interfaces:**
- Consumes: `Flight` (Task 2), `FlightPrefs`
- Produces:
  ```ts
  export type DroneStep = "todo" | "done" | "na";
  export type GogglesStep = "none" | "sync" | "merge" | "linked" | "done";
  export type HudStep = "off" | "blocked" | "todo" | "done";
  export interface Steps { drone: DroneStep; goggles: GogglesStep; hud: HudStep }
  export interface GogglesFacts { linked: string[]; candidates: number; mergedSources?: string[] } // linked = offset 순 파일명
  export function stepsOf(f: Flight, g: GogglesFacts, p: FlightPrefs): Steps;
  export function stepTodo(list: { f: Flight; s: Steps }[]): { drone: Flight[]; goggles: Flight[]; hud: Flight[]; hudBlocked: number };
  export const isPendingView = (s: Steps) => boolean; // 사이드바 "대기"
  ```

- [ ] **Step 1: Write the failing tests**
  - `"클립 하나 = 드론 na"`: `stepsOf(single, {linked:[],candidates:0}, defaultPrefs()).drone === "na"`.
  - `"고글: 후보 있으면 sync, 연결 2개 + 병합본 다르면 merge, 1개면 linked"`: 각각 `"sync"`, `"merge"`, `"linked"`; `mergedSources` 가 linked 와 같으면 `"done"`.
  - `"드론 병합이 안 끝난 비행은 고글 merge 대신 linked, HUD blocked"`: pending 비행 + linked 2개 → `goggles === "linked"`, `hud === "blocked"`; `stepTodo` 의 `hudBlocked === 1`, `hud.length === 0`.
  - `"HUD: 다 끈 비행은 off, 만든 비행은 done, missing 은 off"`.
  - `"stepTodo 는 시작 시각 순"`.
  - `"isPendingView: 어느 단계든 todo/sync/merge 면 true"`.

- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** — HUD 원함 = `p.instruments || p.map || (p.goggles && linked.length > 0)` (기존 `batchTodo` 와 같은 식).
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat: per-step flight state`

---

### Task 4: 지도 오류 표시

**Files:**
- Modify: `src/map.ts` (`TileSource`), `src/render.ts:301-309`, `src/ui/Project.tsx` (Player 미니맵 근처), `src/i18n.ts` + locales
- Test: `test/map.test.ts`

**Interfaces:**
- Produces: `TileSource.error: string | null` (세션 실패 시 `err.mapSession` 문구), `TileSource.onError?: (msg: string) => void`

- [ ] **Step 1: Failing test** `"세션 403 이면 error 가 채워지고 타일은 null"`: `globalThis.fetch` 를 `{ ok:false, status:403, text: async()=>"Permission denied" }` 로 바꾸고 `await src.load(0,0,0)` → `src.get(0,0,0) === null`, `src.error` 에 `"403"` 포함, `onError` 1회 호출.
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** — `getSession` 실패를 잡아 `error` 저장 + `onError` (한 번만). render.ts: prefetch 실패 시 `opts.onWarn?.(t("map.failed", { msg, origin }))`. Player: `tiles.error` 가 있으면 미니맵 위젯 아래 `<p class="note warn">` 로 `map.failed` 문구.
  새 키 `map.failed`: ko `"지도를 불러오지 못했습니다 ({msg}). Google Cloud 에서 키의 웹사이트 제한에 {origin}/* 를 추가하세요."`, en `"Couldn't load the map ({msg}). In Google Cloud, add {origin}/* to the key's website restrictions."`
- [ ] **Step 4: Run** `pnpm test` → PASS
- [ ] **Step 5: Commit** `fix: show map tile errors instead of hiding them`

---

### Task 5: 앱 컨트롤러 — 프로젝트 열기·쓰기 위치·단계 실행 (`store.ts`, `app.tsx`)

**Files:**
- Modify: `src/store.ts` (IndexedDB, `DIRS`), `src/app.tsx`

**Interfaces:**
- Consumes: `guessFor`/`resolveDirs`/`RolePicks` (Task 1), `Library.adopt`, `Flight.synthetic/missing` (Task 2), `stepsOf`/`stepTodo` (Task 3)
- Produces (AppCtx 변경):
  ```ts
  openProject: (project: FileSystemDirectoryHandle, picks: RolePicks) => Promise<void>; // openFolder 대체
  savedProject: { project: FileSystemDirectoryHandle; picks: RolePicks } | null;       // savedRoot/savedGoggles 대체
  setRole: (role: Role, h: FileSystemDirectoryHandle | null) => Promise<void>;          // 열린 뒤 칸 바꾸기 (setGogglesFolder/linkLogsFolder 대체)
  reconnect: (role: Role) => Promise<void>;                                             // reconnectGoggles 대체
  stepsOf: (f: Flight) => Steps;
  stepTodo: () => ReturnType<typeof import("./steps.ts").stepTodo>;
  runStep: (step: "drone" | "goggles" | "hud" | "all") => Promise<void>;                // runAll/batchTodo 대체
  batch: { step: "drone" | "goggles" | "hud"; i: number; n: number; label: string } | null;
  showSetup: boolean; setShowSetup: (b: boolean) => void;
  // 삭제: tidyExcluded, restoreExcluded, openFolder, savedRoot, savedGoggles, setGogglesFolder, linkGogglesFolder, linkLogsFolder, reconnectGoggles, runAll, batchTodo
  ```

- [ ] **Step 1: store.ts** — `saveProject(project, picks)` / `loadProject()` (IndexedDB 키 `"project"`, 값 `{ project, picks }`). `loadProject` 에 값이 없고 예전 `"root"` 가 있으면 `{ project: root, picks: { gogglesRaw: 예전 "goggles" ?? undefined, logs: 예전 "logs" ?? undefined } }` 로 돌려준다. `DIRS` 는 Task 1 이 쓰는 예전 이름 상수로만 남김. `writeState(root)` 의 root = `dirs.project`.
- [ ] **Step 2: app.tsx 열기** — `openProject`: 권한(project·결과 폴더 readwrite, 원본 read) → `guessFor(project, !!picks.gogglesRaw)` → `resolveDirs` → `saveProject` → `scan(reload)`. scan 뒤 `lib.adopt` 가 있으면 `update` 로 `state.videos` 에 저장. `.part` 정리는 세 결과 폴더.
- [ ] **Step 3: 쓰기 위치** (spec §3 표 그대로)
  - `doMerge`: 단일 클립 분기 삭제(단일 클립은 ① 대상이 아님). `d.droneMerged` 에 쓰고 원본 이동(`moveRaw`) 삭제.
  - `doGogglesMerge`: `d.gogglesMerged`.
  - `doOverlay`: 입력 = `f.output.ref.handle` (raw·merged·legacy 어디든), 출력 `d.hud`. `synthetic` 비행이면 HUD 기록 저장 때 원본 기록도 함께 저장.
  - `addGoggles`: 대상 = `d.gogglesRaw`(쓰기 권한 요청), 없으면 `project/goggles_raw` 만들고 `setRole("gogglesRaw", 그 폴더)`.
  - `moveRaw`, `tidyExcluded`, `restoreExcluded` 삭제. YouTube 업로드는 파일을 옮기지 않음(지금도 안 옮김 — 확인만).
- [ ] **Step 4: 단계 실행** — `runStep(step)`: `"all"` 이면 drone → scan → goggles → scan → hud 순. 각 단계: `stepTodo()` 로 대상 → 비행마다 실행 (drone: `doMerge`+기록; goggles: `s.goggles === "sync"` 면 `syncCore(f, candidates)` 후 병합 필요하면 `doGogglesMerge`; hud: `doOverlay`). 실패 처리·중단·`ov.noTelemetry` 처리는 기존 `runAll` 규칙 그대로. 끝나면 `batch.done`/`batch.doneSome` 에 `hudBlocked` 가 있으면 `step.hudBlocked` 알림 추가. 비행 하나용 `run()` 은 같은 단계 함수 사용.
- [ ] **Step 5: 자동 맞춤 제거** — `autoTried`/`autoRunning` effect 삭제.
- [ ] **Step 6: Run** `pnpm build` → 타입 오류 없음 (UI 는 Task 6 에서 맞춤; 이 단계에서 깨지는 UI 호출은 Task 6 의 새 이름으로 임시 연결하지 말고 Task 6 과 한 커밋으로 묶어도 됨)
- [ ] **Step 7: Commit** `feat: open project by roles, never move raw files, step runner`

---

### Task 6: 화면 — 흐름도 설정, 단계 줄, 정리

**Files:**
- Create: `src/ui/Setup.tsx`, `src/ui/StepBar.tsx`
- Modify: `src/ui/Shell.tsx` (Welcome → Setup, `FolderStatus`, `JobCard`, 사이드바 카운트), `src/ui/Flights.tsx` (BatchButton 삭제, `stagesOf` 가 `app.stepsOf` 사용, 대기/완료 필터 = `isPendingView`, missing 칩), `src/ui/Views.tsx` (ExcludedView: tidy 버튼 삭제, 복귀 = `setOverride(name,"excluded",false)`), `src/ui/Project.tsx` (`out.location` 경로 = 실제 폴더 이름, 고글 폴더 버튼 → `setRole`), `src/styles.css`, `src/i18n.ts` + locales

**Interfaces:**
- Consumes: Task 5 ctx

- [ ] **Step 1: Setup.tsx** — 목업 B (`.superpowers/brainstorm/*/content/folder-setup.html` 의 B 안) 구조: 위 프로젝트 칸, 3열 흐름(원본 → 병합 → 합성; ③ HUD 칸이 두 줄에 걸침), 아래 비행기록 칸, "시작". 칸 = 아이콘·역할명·폴더 이름·개수(`countMedia`: 드론 `RAW_RE`, 고글 `GOGGLES_RE`, 병합본 `/_merged\.mp4$/i`)·상태 태그(찾음 / 새로 만듦 / 읽기 전용 / 다시 연결 / 없음)·바꾸기. 드론 원본 0개면 칸 경고색. 바꾸기 = `showDirectoryPicker` (원본 read, 결과 readwrite). 열린 상태에서 열면(`showSetup`) 같은 화면이 모달로 뜨고 "적용" = `openProject`. 좁은 화면(<720px)은 흐름을 세로로.
- [ ] **Step 2: StepBar.tsx** — `① 드론 병합 {n} [실행] → ② 고글 {n} [실행] → ③ HUD {n} [실행]  [전부 순서대로]`. n=0 이면 체크 + 비활성. `hudBlocked > 0` 이면 ③ 아래 작은 글씨 `step.hudBlocked`. 작업 중 전부 비활성.
- [ ] **Step 3: Shell** — `FolderStatus` 는 역할 6개를 작은 줄로(missing 이면 "다시 연결" → `reconnect(role)`), "폴더 바꾸기" → `setShowSetup(true)`. `JobCard` batch 줄: `{단계 이름} · {i}/{n}`.
- [ ] **Step 4: 문구** — 새 키 (ko / en):
  `setup.project` 프로젝트 폴더 / Project folder · `setup.projectHint` 상태 파일과 새 결과 폴더가 여기 생깁니다 / Holds the state file and any new output folders · `role.droneRaw` 드론 원본 / Drone originals · `role.gogglesRaw` 고글 원본 / Goggles originals · `role.droneMerged` ① 드론 병합본 / ① Merged drone · `role.gogglesMerged` ② 고글 병합본 / ② Merged goggles · `role.hud` ③ HUD 영상 / ③ HUD videos · `role.logs` 비행기록 / Flight records · `role.found` 찾음 / Found · `role.create` 새로 만듦 / Will create · `role.readonly` 읽기 전용 / Read-only · `role.none` 없음 / None · `role.count` {n}개 / {n} · `flow.raw` 원본 / Originals · `flow.merge` 병합 / Merge · `flow.compose` 합성 / Compose · `step.drone` 드론 병합 / Drone merge · `step.goggles` 고글 / Goggles · `step.hud` HUD / HUD · `step.run` 실행 / Run · `step.all` 전부 순서대로 / Run all in order · `step.hudBlocked` 병합 먼저 {n}개 / {n} need merging first · `flight.missing` 파일 없음 / File missing · `setup.apply` 적용 / Apply.
  쓰지 않게 된 키(`batch.run`, `batch.hint`, `excluded.tidy`, `setup.drone*`, `setup.goggles*`, `gfolder.*` 중 미사용)는 모든 언어에서 함께 삭제.
- [ ] **Step 5: Run** `pnpm build && pnpm test` → 통과
- [ ] **Step 6: Smoke** `pnpm dev` → Chrome 에서 첫 화면이 흐름도로 뜨고 콘솔 오류 없음 (폴더 선택 창은 사람이 눌러야 하므로 여기까지)
- [ ] **Step 7: Commit** `feat: flow-style folder setup and step bar`

---

### Task 7: 문서 + 실제 폴더 확인

**Files:**
- Modify: `docs/ARCHITECTURE.md` (폴더 구조 표·일괄 처리·고글 자동 맞춤 문단), `README.ko.md`, `README.md` (폴더 설명 부분만; ja/zh/es README 는 영어 README 링크 문구 유지)

- [ ] **Step 1: 문서 갱신** — 예전 "`<폴더>/` = 병합 대기, `_sources/` 로 이동" 설명을 역할 표로 교체, "모두 처리" → 단계 줄, "폴더를 열면 자동 맞춤" 문장 삭제, 지도 키 리퍼러 안내에 `localhost` 예시.
- [ ] **Step 2: 실제 폴더 확인 (사람)** — `pnpm dev` → 프로젝트 폴더 `~/Desktop/Avata2` → 흐름도에 드론 원본 101 / 고글 원본 26 / 병합본 7 찾음 / 고글 병합본·HUD 새로 만듦. 시작 후: ① 대상에 이미 병합된 비행 없음, `Avata2/aircraft_raw` 파일 수 변화 없음(`ls | wc -l` = 101).
- [ ] **Step 3: Commit** `docs: describe folder roles and step batch`
