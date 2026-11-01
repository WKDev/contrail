import { test } from "node:test";
import assert from "node:assert/strict";
import { keyBlack, keyWhite, looksInset } from "../src/osdkey.ts";

// 하늘(밝은 무채색 구름) 위에 그림자 두른 흰 글자 막대 하나
function scene() {
  const w = 120, h = 60, data = new Uint8ClampedArray(w * h * 4);
  const put = (x: number, y: number, v: number[]) => data.set([...v, 255], (y * w + x) * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(x, y, x < 60 ? [225, 228, 232] : [90, 140, 210]); // 왼쪽 구름, 오른쪽 하늘
  for (let y = 20; y < 40; y++) for (let x = 80; x < 100; x++) put(x, y, [20, 20, 20]); // 그림자
  for (let y = 23; y < 37; y++) for (let x = 87; x < 93; x++) put(x, y, [250, 250, 250]); // 흰 글자 획 (1080p 기준 6px 굵기)
  return { data, width: w, height: h };
}
const alpha = (p: ReturnType<typeof scene>, x: number, y: number) => p.data[(y * p.width + x) * 4 + 3];

test("전체 화면 키: 그림자 두른 흰 글자는 남고 구름·하늘은 지워진다", () => {
  const p = scene();
  keyWhite(p, 1080);
  assert.ok(alpha(p, 90, 30) > 200, "글자");
  assert.ok(alpha(p, 30, 30) < 10, "구름");
  assert.ok(alpha(p, 70, 10) < 10, "하늘");
});

test("축소 화면 키: 검은 여백은 지우고 글자는 남긴다", () => {
  const p = scene();
  keyBlack(p);
  assert.equal(alpha(p, 85, 21), 0);
  assert.equal(alpha(p, 90, 30), 255);
});

test("배율 추정: 구석이 검으면 축소 화면", () => {
  const w = 192, h = 108;
  const black = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  assert.equal(looksInset(black), true);
  assert.equal(looksInset(scene()), false);
});

test("고정 OSD 통계: 늘 흰 꽉 찬 상자는 안의 검은 글자까지 통째로 살린다", async () => {
  const { staticMask, keyBlack } = await import("../src/osdkey.ts");
  const w = 400, h = 400; // 상자 = 화면 높이의 약 5% (실제 모드 표시 크기)
  const frame = (bg: number) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let k = 0; k < w * h; k++) data.set([bg, bg, bg, 255], k * 4);
    for (let y = 40; y < 60; y++) for (let x = 20; x < 42; x++) data.set([245, 245, 245, 255], (y * w + x) * 4); // 흰 상자
    for (let y = 45; y < 55; y++) for (let x = 29; x < 33; x++) data.set([10, 10, 10, 255], (y * w + x) * 4); // 검은 글자
    return { data, width: w, height: h };
  };
  const st = staticMask([frame(0), frame(30), frame(80), frame(0)]);
  assert.equal(st.data[50 * w + 30], 253, "상자 안 글자");
  assert.equal(st.data[42 * w + 22], 254, "상자 바탕");
  assert.equal(st.data[10 * w + 150], 0, "빈 곳");
  const p = frame(0);
  keyBlack(p, { ...st, x0: 0, y0: 0, W: w, H: h });
  assert.equal(p.data[(50 * w + 30) * 4 + 3], 255, "글자 유지");
  assert.equal(p.data[(10 * w + 150) * 4 + 3], 0, "여백 제거");
});

test("빨강·주황은 오른쪽 아래 인디케이터 줄에서만", async () => {
  const { keyWhite } = await import("../src/osdkey.ts");
  const w = 40, h = 20;
  const red = () => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let k = 0; k < w * h; k++) data.set([210, 25, 35, 255], k * 4);
    return { data, width: w, height: h };
  };
  const inside = red(), outside = red();
  keyWhite(inside, 1080, undefined, { x0: 1500, y0: 950, W: 1920, H: 1080 });
  keyWhite(outside, 1080, undefined, { x0: 300, y0: 950, W: 1920, H: 1080 });
  assert.ok(inside.data[(10 * w + 20) * 4 + 3] > 200, "오른쪽 아래");
  assert.equal(outside.data[(10 * w + 20) * 4 + 3], 0, "왼쪽 아래");
});
