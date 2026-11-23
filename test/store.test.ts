import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeRecord } from "../src/store.ts";

test("다시 병합해도 업로드 기록은 유지", () => {
  const prev = { sources: ["a"], title: "my", start: 0, duration: 1, youtubeId: "yt", playlistId: "pl", uploadedAt: "2026" };
  const next = { sources: ["a", "b"], title: "DJI", start: 0, duration: 2 };
  const r = mergeRecord(prev, next);
  assert.deepEqual(r.sources, ["a", "b"]);
  assert.equal(r.duration, 2);
  assert.equal(r.youtubeId, "yt");
  assert.equal(r.playlistId, "pl");
  assert.equal(r.uploadedAt, "2026");
  assert.deepEqual(mergeRecord(undefined, next), next);
});

test("기체 배치가 있으면 그것, 없으면 예전 layout", async () => {
  const { layoutOf, emptyState } = await import("../src/store.ts");
  const s = { ...emptyState(), layout: { style: "old" } as any, layouts: { pavopro2: { style: "betaflight" } as any } };
  assert.equal(layoutOf(s, "pavopro2").style, "betaflight");
  assert.equal(layoutOf(s, "avata2").style, "old");
  assert.equal(layoutOf(s).style, "old");
});

test("비행 데이터 없는 기체는 계기·지도 기본 끔", async () => {
  const { prefsDefault } = await import("../src/store.ts");
  assert.deepEqual([prefsDefault(false).instruments, prefsDefault(false).map, prefsDefault(false).goggles], [false, false, true]);
  assert.deepEqual([prefsDefault(true).instruments, prefsDefault(true).map], [true, true]);
});
