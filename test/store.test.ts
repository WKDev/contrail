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
