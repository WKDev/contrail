import { test } from "node:test";
import assert from "node:assert/strict";
import { GAP, snapMove, snapResize, type SnapBox } from "../src/snap.ts";

const W = 1600, H = 900;
// 픽셀 원(지름 d, 중심 cx,cy) → 비율 상자
const circle = (cx: number, cy: number, d: number): SnapBox => ({ x: (cx - d / 2) / W, y: (cy - d / 2) / H, w: d / W, h: d / H, round: true });
const center = (b: { x: number; y: number; w: number; h: number }) => [(b.x + b.w / 2) * W, (b.y + b.h / 2) * H];

test("원끼리 대각선으로 다가가면 테두리가 맞닿게 붙는다", () => {
  const other = circle(400, 400, 200);
  // 중심 거리 = 반지름 합(200) 근처, 대각선 방향
  const raw = circle(400 + 145, 400 + 145, 200); // 거리 ≈ 205
  const r = snapMove(raw, true, [other], W, H, 9);
  assert.equal(r.touch, 0);
  const [x, y] = center(r.box);
  assert.ok(Math.abs(Math.hypot(x - 400, y - 400) - 200) < 0.01);
});

test("원끼리 간격(GAP)을 두고도 붙는다", () => {
  const other = circle(400, 400, 200);
  const target = 200 + GAP * W;
  const raw = circle(400 + target + 4, 400, 200);
  const r = snapMove(raw, true, [other], W, H, 9);
  assert.equal(r.touch, 0);
  const [x, y] = center(r.box);
  assert.ok(Math.abs(x - (400 + target)) < 0.01 && Math.abs(y - 400) < 0.01); // 거의 나란하면 정확히 가로로
});

test("멀리 있으면 원 스냅 대신 기준선 스냅", () => {
  const other = circle(400, 400, 200);
  const raw = circle(1000, 453, 100); // 가운데 가로선(450) 근처
  const r = snapMove(raw, true, [other], W, H, 9);
  assert.equal(r.touch, undefined);
  assert.ok(Math.abs(center(r.box)[1] - 450) < 0.01);
});

test("크기 조절 시 같은 종류 위젯과 같은 크기로 맞춰진다", () => {
  const other = circle(400, 400, 200);
  const start = circle(1000, 400, 150);
  // 오른쪽 아래 모서리를 46px 늘림 → 196px, 200 과 4px 차이
  const r = snapResize(start, "se", 46 / W, 46 / H, true, [other], W, H, 9, true);
  assert.equal(r.same, 0);
  assert.ok(Math.abs(r.box.w * W - 200) < 0.01 && Math.abs(r.box.h * H - 200) < 0.01);
});
