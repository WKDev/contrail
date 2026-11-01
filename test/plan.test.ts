import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, decide, groupClips, pairKey, parseStart, type Clip } from "../src/plan.ts";

const clip = (name: string, duration: number): Clip => ({
  name: `${name}.MP4`,
  stem: name,
  start: parseStart(name)!,
  duration,
  size: 0,
});

test("DJI 자동분할은 점수 없이도 병합, 짧은 클립 제외", () => {
  const cs = [
    clip("DJI_20261011171624_0013_D", 12.3),
    clip("DJI_20261011171705_0014_D", 460.3),
    clip("DJI_20261011172445_0015_D", 32.3),
    clip("DJI_20261011172500_0016_D", 0.8),
  ];
  const ds = decide(cs, {}, {}, DEFAULT_SETTINGS);
  assert.deepEqual(ds.map((d) => d.mergePrev), [false, false, true, false]);
  assert.deepEqual(ds.map((d) => d.excluded), [false, false, false, true]);
  assert.deepEqual(groupClips(cs, ds).map((g) => g.length), [1, 2]);
});

test("짧은 간격 + 연속 장면이면 병합, 다른 장면이면 분리, 수동 덮어쓰기", () => {
  const a = clip("DJI_20261030173918_0018_D", 12.6);
  const b = clip("DJI_20261030173932_0019_D", 13.8);
  const c = clip("DJI_20261030173947_0020_D", 10);
  const scores = { [pairKey(a, b)]: 0.05, [pairKey(b, c)]: 0.9 };
  let ds = decide([a, b, c], scores, {}, DEFAULT_SETTINGS);
  assert.deepEqual(ds.map((d) => d.mergePrev), [false, true, false]);
  assert.equal(ds[2].mergeReason, "다른 장면");
  ds = decide([a, b, c], scores, { [c.name]: { mergePrev: true }, [b.name]: { excluded: true } }, DEFAULT_SETTINGS);
  assert.deepEqual(ds.map((d) => d.mergePrev), [false, false, false]); // 제외된 b 뒤에는 병합 불가
});
