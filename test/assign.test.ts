import { test } from "node:test";
import assert from "node:assert/strict";
import { learnClockErr, medianErr, ownerOfGoggles, shiftGoggles } from "../src/assign.ts";

const T = Date.UTC(2026, 10, 15, 3, 0, 0);
const fl = (id: string, aircraft: string, startSec: number, durSec: number) => ({ id, aircraft, start: T + startSec * 1000, end: T + (startSec + durSec) * 1000, day: "2026-11-15" });
const g = (name: string, startSec: number, durSec: number) => ({ name, start: T + startSec * 1000, duration: durSec });
const zero = () => 0;

test("시간 겹침이 큰 기체가 주인", () => {
  const o = ownerOfGoggles([g("G1", 0, 300)], [fl("a1", "avata2", 10, 280), fl("p1", "pavopro2", 1000, 300)], {}, zero, {});
  assert.equal(o.get("G1")!.aircraft, "avata2");
  assert.equal(o.get("G1")!.by, "time");
});

test("연결된 녹화는 연결된 비행의 기체가 주인", () => {
  const o = ownerOfGoggles([g("G1", 0, 300)], [fl("a1", "avata2", 0, 300), fl("p1", "pavopro2", 2000, 300)], { p1: [{ file: "G1" }] }, zero, {});
  assert.equal(o.get("G1")!.aircraft, "pavopro2");
  assert.equal(o.get("G1")!.by, "linked");
});

test("사용자 선택이 최우선", () => {
  const o = ownerOfGoggles([g("G1", 0, 300)], [fl("a1", "avata2", 0, 300)], { a1: [{ file: "G1" }] }, zero, { G1: "pavopro2" });
  assert.equal(o.get("G1")!.aircraft, "pavopro2");
  assert.equal(o.get("G1")!.by, "manual");
});

test("비슷하게 겹치면 ambiguous, 후보 두 기체", () => {
  const o = ownerOfGoggles([g("G1", 0, 300)], [fl("a1", "avata2", 0, 150), fl("p1", "pavopro2", 150, 140)], {}, zero, {});
  assert.equal(o.get("G1")!.by, "ambiguous");
  assert.equal(o.get("G1")!.aircraft, undefined);
  assert.deepEqual(o.get("G1")!.candidates.sort(), ["avata2", "pavopro2"]);
});

test("시계 오차를 적용하면 후보가 된다", () => {
  const flights = [fl("p1", "pavopro2", 0, 300)];
  const goggles = [g("G1", 600, 300)]; // 고글 시계가 10분 앞섬
  assert.equal(ownerOfGoggles(goggles, flights, {}, zero, {}).get("G1")!.by, "none");
  const o = ownerOfGoggles(goggles, flights, {}, (a) => (a === "pavopro2" ? -600 : 0), {});
  assert.equal(o.get("G1")!.aircraft, "pavopro2");
  assert.equal(o.get("G1")!.by, "time");
});

test("learnClockErr 기준", () => {
  assert.equal(learnClockErr(10, 10.6, 0.9), null); // 3초 미만은 무시
  assert.equal(learnClockErr(10, -110, 0.8), -120);
  assert.equal(learnClockErr(10, -110, 0.5), null); // 점수 낮음
  assert.equal(medianErr([-118, -120, -125]), -120);
  assert.equal(shiftGoggles({ start: 1000, x: 1 }, -1).start, 0);
});

// ---- 최종 리뷰 수정 ----
test("시계 오차는 원래 고글 시각 기준 절댓값 (여러 번 맞춰도 쌓이지 않음)", async () => {
  const { clockSample } = await import("../src/assign.ts");
  // 진짜 오차 -10초: 고글 시계 기준 coarse = 100, 실제 offset = 90
  const flightStart = T, gStart = T + 100_000;
  assert.equal(clockSample(gStart, flightStart, 90, 0.9), -10);
  assert.equal(clockSample(gStart, flightStart, 90, 0.9), -10); // 두 번째 녹화도 같은 값
  assert.equal(clockSample(gStart, flightStart, 99, 0.9), null); // 3초 미만
});

test("주인 판정용 비행 찾기는 그 기체 오차로 한 번만 보정", async () => {
  const { bestFlightFor } = await import("../src/assign.ts");
  const fs = [fl("p1", "pavopro2", 0, 300), fl("p2", "pavopro2", 5000, 300)];
  assert.equal(bestFlightFor(g("G1", 600, 300), fs, -600)?.id, "p1");
  assert.equal(bestFlightFor(g("G1", 600, 300), fs, 0), null);
});
