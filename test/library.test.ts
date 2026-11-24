import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLibrary, scanIndex, type Dirs } from "../src/library.ts";
import { DEFAULT_SETTINGS } from "../src/plan.ts";
import { emptyState, type State, type VideoRecord } from "../src/store.ts";

// ---- 가짜 폴더: { 파일명: 크기 } 또는 { 폴더명: {...} } ----
type Tree = { [name: string]: number | Tree };
function fakeDir(name: string, tree: Tree = {}, opts: { broken?: boolean } = {}): FileSystemDirectoryHandle {
  const h: any = {
    kind: "directory",
    name,
    async *entries() {
      if (opts.broken) throw new DOMException("gone", "NotFoundError");
      for (const [n, v] of Object.entries(tree)) yield [n, typeof v === "number" ? fakeFile(n, v) : fakeDir(n, v)];
    },
    async getDirectoryHandle(n: string) {
      const v = tree[n];
      if (!v || typeof v === "number") throw new DOMException("nf", "NotFoundError");
      return fakeDir(n, v);
    },
    async isSameEntry(o: unknown) {
      return o === h;
    },
  };
  return h;
}
// 파일 앞부분 내용 (기체 모델 읽기용)
const contents: Record<string, string> = {};
function fakeFile(name: string, size: number) {
  const bytes = new TextEncoder().encode(contents[name] ?? "");
  return { kind: "file", name, getFile: async () => ({ name, size, lastModified: 0, slice: (a: number, b: number) => ({ arrayBuffer: async () => bytes.slice(a, b).buffer }) }) };
}

// 길이·프레임: 이름으로 정함 (기본 60초, 30fps)
const meta: Record<string, { duration: number; frames: number }> = {};
const info = async (f: File) => meta[f.name] ?? { duration: 60, frames: 1800 };

// 자동분할 쌍: A 460초 → 1초 뒤 B
const A = "DJI_20261030173851_0017_D";
const B = "DJI_20261030174632_0018_D";
meta[`${A}.MP4`] = { duration: 460, frames: 100 };
meta[`${B}.MP4`] = { duration: 30, frames: 200 };

type AC = { raw?: Tree; merged?: Tree; hud?: Tree };
const ac = (id: string, p: AC) => ({ id, raw: fakeDir(`${id}/raw`, p.raw), merged: fakeDir(`${id}/merged`, p.merged), hud: fakeDir(`${id}/hud`, p.hud) });
function dirs(p: AC & { gmerged?: Tree; legacy?: Tree[]; excluded?: Tree; goggles?: FileSystemDirectoryHandle | null; more?: Record<string, AC> }): Dirs {
  const project = fakeDir("DroneArchive");
  return {
    project,
    aircraft: [ac("avata2", p), ...Object.entries(p.more ?? {}).map(([id, x]) => ac(id, x))],
    gogglesRaw: p.goggles ?? null,
    gogglesExtra: null,
    gogglesMerged: fakeDir("goggles_merged", p.gmerged),
    logs: null,
    legacy: (p.legacy ?? []).map((t, i) => fakeDir(`legacy${i}`, t)),
    excluded: p.excluded ? fakeDir("_excluded", p.excluded) : null,
  };
}
const rec = (sources: string[], extra: Partial<VideoRecord> = {}): VideoRecord => ({ sources, title: "t", start: 0, duration: 490, ...extra });
const withVideos = (videos: State["videos"], more: Partial<State> = {}): State => ({ ...emptyState(), videos, ...more });
const lib = async (d: Dirs, st: State) => buildLibrary(await scanIndex(d), st, DEFAULT_SETTINGS, info);

test("원본이 남아 있어도 기록된 병합본이 있으면 완료", async () => {
  const d = dirs({ raw: { [`${A}.MP4`]: 9, [`${B}.MP4`]: 9 }, merged: { [`${A}_merged.MP4`]: 18 } });
  const l = await lib(d, withVideos({ [`${A}_merged.MP4`]: rec([`${A}.MP4`, `${B}.MP4`]) }));
  assert.equal(l.flights.length, 1);
  assert.equal(l.flights[0].status, "done");
  assert.equal(l.flights[0].output?.ref?.dir, "merged");
  assert.equal(l.pendingClips.length, 0);
});

test("기록 없는 병합본은 프레임 수가 맞으면 받아들임", async () => {
  meta[`${A}_merged.MP4`] = { duration: 490, frames: 300 };
  const d = dirs({ raw: { [`${A}.MP4`]: 9, [`${B}.MP4`]: 9 }, merged: { [`${A}_merged.MP4`]: 18 } });
  const l = await lib(d, emptyState());
  assert.equal(l.flights.length, 1);
  assert.equal(l.flights[0].status, "done");
  assert.equal(l.adopt.length, 1);
  assert.equal(l.adopt[0].name, `${A}_merged.MP4`);
  assert.deepEqual(l.adopt[0].rec.sources, [`${A}.MP4`, `${B}.MP4`]);

  meta[`${A}_merged.MP4`] = { duration: 490, frames: 299 };
  const l2 = await lib(d, emptyState());
  assert.equal(l2.flights[0].status, "pending");
  assert.equal(l2.adopt.length, 0);
  delete meta[`${A}_merged.MP4`];
});

test("클립 하나짜리 비행은 원본이 결과", async () => {
  const name = "DJI_20261028130230_0001_D.MP4";
  const l = await lib(dirs({ raw: { [name]: 5 } }), emptyState());
  assert.equal(l.flights.length, 1);
  const f = l.flights[0];
  assert.equal(f.status, "done");
  assert.equal(f.synthetic, true);
  assert.equal(f.output?.name, name);
  assert.equal(f.output?.ref?.dir, "raw");
  assert.deepEqual(f.record?.sources, [name]);
});

test("결과 파일도 원본 MP4 도 없으면 missing", async () => {
  const name = "DJI_20261010160236_0009_D.MP4";
  const l = await lib(dirs({ raw: { "DJI_20261010160236_0009_D.LRF": 1 } }), withVideos({ [name]: rec([name], { youtubeId: "x" }) }));
  assert.equal(l.flights.length, 1);
  assert.equal(l.flights[0].missing, true);
  assert.equal(l.flights[0].youtubeId, "x");
});

test("결과 파일은 없고 원본은 있으면 대기", async () => {
  const d = dirs({ raw: { [`${A}.MP4`]: 9, [`${B}.MP4`]: 9 } });
  const l = await lib(d, withVideos({ [`${A}_merged.MP4`]: rec([`${A}.MP4`, `${B}.MP4`]) }));
  assert.equal(l.flights.length, 1);
  assert.equal(l.flights[0].status, "pending");
  assert.equal(l.flights[0].clips.length, 2);
});

test("_sources 에 옮겨진 원본도 찾는다 (예전 구조)", async () => {
  const ready = fakeDir("2_ready", { [`${A}_merged.MP4`]: 18 });
  const project = fakeDir("old");
  const d: Dirs = {
    project, aircraft: [{ id: "default", raw: project, merged: ready, hud: ready }], gogglesRaw: null, gogglesExtra: null, gogglesMerged: ready, logs: null,
    legacy: [fakeDir("_sources", { [`${A}.MP4`]: 7, [`${B}.MP4`]: 7 })], excluded: null,
  };
  const l = await lib(d, withVideos({ [`${A}_merged.MP4`]: rec([`${A}.MP4`, `${B}.MP4`]) }));
  assert.equal(l.flights.length, 1);
  assert.equal(l.flights[0].status, "done");
  assert.ok(l.flights[0].clips[0].size > 0);
});

test("_excluded 의 원본은 제외로 다시 읽는다", async () => {
  const name = "DJI_20261028131047_0002_D.MP4";
  const d = dirs({ excluded: { [name]: 5 } });
  const l = await lib(d, emptyState());
  assert.equal(l.flights.length, 0);
  assert.ok(l.excluded.some((x) => x.name === name && x.dir === "excluded"));
  const l2 = await lib(d, { ...emptyState(), overrides: { [name]: { excluded: false } } });
  assert.equal(l2.flights.length, 1);
  assert.ok(!l2.excluded.some((x) => x.name === name));
});

test("고글 폴더를 못 읽어도 스캔은 계속", async () => {
  const d = dirs({ raw: { "DJI_20261028130230_0001_D.MP4": 5 }, goggles: fakeDir("google_raw", {}, { broken: true }) });
  const ix = await scanIndex(d);
  assert.equal(ix.gogglesState, "missing");
  const l = await buildLibrary(ix, emptyState(), DEFAULT_SETTINGS, info);
  assert.equal(l.flights.length, 1);
});

test("HUD·고글 병합본은 해당 폴더에서 찾는다", async () => {
  const d = dirs({
    raw: { [`${A}.MP4`]: 9, [`${B}.MP4`]: 9 },
    merged: { [`${A}_merged.MP4`]: 18 },
    hud: { [`${A}_hud.MP4`]: 20 },
    gmerged: { [`${A}_goggles.MP4`]: 20 },
  });
  const srcs = [`${A}.MP4`, `${B}.MP4`];
  const l = await lib(d, withVideos({
    [`${A}_merged.MP4`]: rec(srcs),
    [`${A}_hud.MP4`]: rec(srcs, { variant: "hud" }),
    [`${A}_goggles.MP4`]: rec(srcs, { variant: "goggles", gogglesSources: ["DJI_0001.MOV", "DJI_0002.MOV"] }),
  }));
  assert.equal(l.flights[0].overlay?.ref?.dir, "hud");
  assert.equal(l.flights[0].gogglesOut?.ref?.dir, "gmerged");
});

// ---- 최종 리뷰 수정 ----
test("예전 3_uploaded 의 병합본 + _sources 원본 = 완료", async () => {
  const project = fakeDir("old");
  const ready = fakeDir("2_ready");
  const d: Dirs = {
    project, aircraft: [{ id: "default", raw: project, merged: ready, hud: ready }], gogglesRaw: null, gogglesExtra: null, gogglesMerged: ready, logs: null,
    legacy: [fakeDir("_sources", { [`${A}.MP4`]: 7, [`${B}.MP4`]: 7 }), fakeDir("3_uploaded", { [`${A}_merged.MP4`]: 18 })], excluded: null,
  };
  const l = await lib(d, withVideos({ [`${A}_merged.MP4`]: rec([`${A}.MP4`, `${B}.MP4`], { youtubeId: "yt" }) }));
  assert.equal(l.flights.length, 1);
  assert.equal(l.flights[0].status, "done");
  assert.ok(!l.flights[0].missing);
  assert.equal(l.flights[0].youtubeId, "yt");
});

test("결과 파일이 없고 원본이 _sources 에만 있으면 missing (사라지지 않음)", async () => {
  const project = fakeDir("old");
  const d: Dirs = {
    project, aircraft: [{ id: "default", raw: project, merged: fakeDir("2_ready"), hud: fakeDir("2_ready") }], gogglesRaw: null, gogglesExtra: null, gogglesMerged: fakeDir("2_ready"), logs: null,
    legacy: [fakeDir("_sources", { [`${A}.MP4`]: 7, [`${B}.MP4`]: 7 })], excluded: null,
  };
  const l = await lib(d, withVideos({ [`${A}_merged.MP4`]: rec([`${A}.MP4`, `${B}.MP4`], { youtubeId: "yt" }) }));
  assert.equal(l.flights.length, 1);
  assert.equal(l.flights[0].missing, true);
});

test("병합본 폴더를 드론 원본과 같은 폴더로 골라도 완료로 본다", async () => {
  const same = fakeDir("aircraft_raw", { [`${A}.MP4`]: 9, [`${B}.MP4`]: 9, [`${A}_merged.MP4`]: 18 });
  const d: Dirs = { ...dirs({}), aircraft: [{ id: "avata2", raw: same, merged: same, hud: fakeDir("hud") }] };
  const l = await lib(d, withVideos({ [`${A}_merged.MP4`]: rec([`${A}.MP4`, `${B}.MP4`]) }));
  assert.equal(l.flights.length, 1);
  assert.equal(l.flights[0].status, "done");
});

test("장면 분석 전인 이웃 클립은 analyzing", async () => {
  const C = "DJI_20261028130230_0001_D", D = "DJI_20261028130331_0002_D"; // 60초 클립, 1초 간격, 자동분할 아님
  const l = await lib(dirs({ raw: { [`${C}.MP4`]: 5, [`${D}.MP4`]: 5 } }), emptyState());
  assert.equal(l.flights.length, 2);
  assert.ok(l.flights.every((f) => f.analyzing));
  const scored = await lib(dirs({ raw: { [`${C}.MP4`]: 5, [`${D}.MP4`]: 5 } }), { ...emptyState(), scores: { [`${C}>${D}`]: 0.9 } });
  assert.ok(scored.flights.every((f) => !f.analyzing));
});

test("프레임 수가 안 맞는 기록 없는 병합본은 orphan 으로 표시", async () => {
  meta[`${A}_merged.MP4`] = { duration: 490, frames: 299 };
  const l = await lib(dirs({ raw: { [`${A}.MP4`]: 9, [`${B}.MP4`]: 9 }, merged: { [`${A}_merged.MP4`]: 18 } }), emptyState());
  assert.equal(l.flights[0].status, "pending");
  assert.equal(l.flights[0].orphan, `${A}_merged.MP4`);
  delete meta[`${A}_merged.MP4`];
});

// ---- 기체 여러 대 ----
test("기체가 다르면 시간이 붙어 있어도 따로 묶는다", async () => {
  const d = dirs({ raw: { [`${A}.MP4`]: 9 }, more: { pavopro2: { raw: { [`${B}.MP4`]: 9 } } } });
  const l = await lib(d, emptyState());
  assert.equal(l.flights.length, 2);
  assert.deepEqual(l.flights.map((f) => f.aircraft).sort(), ["avata2", "pavopro2"]);
  assert.ok(l.flights.every((f) => f.clips.length === 1));
});

test("기록의 기체는 결과 파일이 있는 기체", async () => {
  const X = "DJI_20261115123631_0001_D", Y = "DJI_20261115124400_0002_D";
  const d = dirs({ more: { pavopro2: { merged: { [`${X}_merged.MP4`]: 18 } } } });
  const l = await lib(d, withVideos({ [`${X}_merged.MP4`]: rec([`${X}.MP4`, `${Y}.MP4`]) }));
  assert.equal(l.flights.length, 1);
  assert.equal(l.flights[0].aircraft, "pavopro2");
});

test("기체 모델을 읽는다", async () => {
  const X = "DJI_20261115123631_0001_D";
  contents[`${X}.MP4`] = "xx\0DJI FC8885-\0yyDJI O4P\0zz";
  const ix = await scanIndex(dirs({ raw: { [`${X}.MP4`]: 9 } }));
  assert.equal(ix.aircraft[0].id, "avata2");
  assert.equal(ix.aircraft[0].model, "O4P");
  delete contents[`${X}.MP4`];
});

test("실제 파일처럼 모델 뒤가 protobuf 태그여도 읽는다", async () => {
  const X = "DJI_20261115123631_0001_D";
  contents[`${X}.MP4`] = "a\x12\x0bDJI FC8885-\x12\x07DJI O4P\x12\x05zz";
  const ix = await scanIndex(dirs({ raw: { [`${X}.MP4`]: 9 } }));
  assert.equal(ix.aircraft[0].model, "O4P");
  delete contents[`${X}.MP4`];
});

test("기록의 기체보다 결과 파일 위치가 우선 (default·이름 바뀐 기체)", async () => {
  const d = dirs({ raw: { [`${A}.MP4`]: 9, [`${B}.MP4`]: 9 }, merged: { [`${A}_merged.MP4`]: 18 } });
  const l = await lib(d, withVideos({ [`${A}_merged.MP4`]: rec([`${A}.MP4`, `${B}.MP4`], { aircraft: "default" }) }));
  assert.equal(l.flights[0].aircraft, "avata2");
  const l2 = await lib(d, withVideos({ [`${A}_merged.MP4`]: rec([`${A}.MP4`, `${B}.MP4`], { aircraft: "oldname" }) }));
  assert.equal(l2.flights[0].aircraft, "avata2");
});

test("단일 기체 모드에서는 default 를 기록에 남기지 않는다", async () => {
  const project = fakeDir("old", { "DJI_20261028130230_0001_D.MP4": 5 });
  const d: Dirs = { project, aircraft: [{ id: "default", raw: project, merged: fakeDir("2_ready"), hud: fakeDir("2_ready") }], gogglesRaw: null, gogglesExtra: null, gogglesMerged: fakeDir("2_ready"), logs: null, legacy: [], excluded: null };
  const l = await lib(d, emptyState());
  assert.equal(l.flights[0].aircraft, "default");
  assert.equal(l.flights[0].record?.aircraft, undefined);
});
