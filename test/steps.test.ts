import { test } from "node:test";
import assert from "node:assert/strict";
import { isPendingView, stepsOf, stepTodo } from "../src/steps.ts";
import { defaultPrefs } from "../src/store.ts";
import type { Flight } from "../src/library.ts";

const clip = (stem: string) => ({ name: `${stem}.MP4`, stem, start: 0, duration: 60, size: 1 });
const flight = (id: string, start: number, extra: Partial<Flight> = {}): Flight => ({
  id, number: 1, day: "2026-11-23", start, end: start + 60000, duration: 60, size: 1,
  clips: [clip(id)], aircraft: "a", joins: [], status: "done", output: { name: `${id}.MP4` }, ...extra,
});
const pending2 = (id: string, start = 0) => flight(id, start, { status: "pending", clips: [clip(id), clip(`${id}b`)], output: undefined });
const none = { linked: [], candidates: 0 };
const p = defaultPrefs();

test("클립 하나 = 드론 na, 병합 대기 = todo, 병합됨 = done", () => {
  assert.equal(stepsOf(flight("a", 0), none, p).drone, "na");
  assert.equal(stepsOf(pending2("b"), none, p).drone, "todo");
  assert.equal(stepsOf(flight("c", 0, { clips: [clip("c"), clip("d")] }), none, p).drone, "done");
});

test("고글: 후보 있으면 sync, 연결 2개 + 병합본 다르면 merge, 1개면 linked, 같으면 done", () => {
  const f = flight("a", 0);
  assert.equal(stepsOf(f, { linked: [], candidates: 2 }, p).goggles, "sync");
  assert.equal(stepsOf(f, { linked: ["x", "y"], candidates: 0 }, p).goggles, "merge");
  assert.equal(stepsOf(f, { linked: ["x"], candidates: 0 }, p).goggles, "linked");
  assert.equal(stepsOf(f, { linked: ["x", "y"], candidates: 0, mergedSources: ["x", "y"] }, p).goggles, "done");
  assert.equal(stepsOf(f, none, p).goggles, "none");
});

test("드론 병합이 안 끝난 비행은 고글 merge 대신 linked, HUD blocked", () => {
  const f = pending2("a");
  const s = stepsOf(f, { linked: ["x", "y"], candidates: 0 }, p);
  assert.equal(s.goggles, "linked");
  assert.equal(s.hud, "blocked");
  const todo = stepTodo([{ f, s }]);
  assert.equal(todo.hudBlocked, 1);
  assert.equal(todo.hud.length, 0);
  assert.equal(todo.drone.length, 1);
});

test("HUD: 다 끈 비행은 off, 만든 비행은 done, missing 은 off", () => {
  const off = { ...p, instruments: false, map: false, goggles: false };
  assert.equal(stepsOf(flight("a", 0), none, off).hud, "off");
  assert.equal(stepsOf(flight("a", 0), none, p).hud, "todo");
  assert.equal(stepsOf(flight("a", 0, { overlay: { name: "a_hud.MP4", record: { sources: [], title: "", start: 0, duration: 0 } } }), none, p).hud, "done");
  assert.equal(stepsOf(flight("a", 0, { missing: true }), none, p).hud, "off");
  // 고글 OSD 만 켠 비행: 연결된 고글이 있어야 HUD 대상
  const gogOnly = { ...off, goggles: true };
  assert.equal(stepsOf(flight("a", 0), none, gogOnly).hud, "off");
  assert.equal(stepsOf(flight("a", 0), { linked: ["x"], candidates: 0 }, gogOnly).hud, "todo");
});

test("stepTodo 는 시작 시각 순", () => {
  const a = flight("a", 2000), b = flight("b", 1000);
  const todo = stepTodo([a, b].map((f) => ({ f, s: stepsOf(f, { linked: [], candidates: 1 }, p) })));
  assert.deepEqual(todo.goggles.map((f) => f.id), ["b", "a"]);
  assert.deepEqual(todo.hud.map((f) => f.id), ["b", "a"]);
});

test("isPendingView: 어느 단계든 할 일이 있으면 true", () => {
  assert.equal(isPendingView({ drone: "na", goggles: "none", hud: "done" }), false);
  assert.equal(isPendingView({ drone: "todo", goggles: "none", hud: "blocked" }), true);
  assert.equal(isPendingView({ drone: "na", goggles: "sync", hud: "done" }), true);
  assert.equal(isPendingView({ drone: "done", goggles: "linked", hud: "todo" }), true);
  assert.equal(isPendingView({ drone: "done", goggles: "linked", hud: "off" }), false);
});

test("분석 중인 비행은 HUD blocked, orphan 은 드론 병합 대상에서 빠짐", () => {
  const a = flight("a", 0, { analyzing: true });
  assert.equal(stepsOf(a, none, p).hud, "blocked");
  const b = { ...pending2("b"), orphan: "b_merged.MP4" };
  const todo = stepTodo([{ f: b, s: stepsOf(b, none, p) }]);
  assert.equal(todo.drone.length, 0);
  assert.equal(todo.orphans, 1);
});

test("missing 비행은 고글 단계도 none", () => {
  assert.equal(stepsOf(flight("a", 0, { missing: true }), { linked: [], candidates: 2 }, p).goggles, "none");
});
