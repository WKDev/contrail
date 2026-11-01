import { test } from "node:test";
import assert from "node:assert/strict";
import { avcCodecFor, bitrateFor } from "../src/render.ts";
import { matchLog, type FlightLog } from "../src/flightlog.ts";

test("H.264 레벨은 화면 크기·프레임 수에 맞춘다", () => {
  assert.equal(avcCodecFor(1920, 1080, 30), "avc1.640028");
  assert.equal(avcCodecFor(1920, 1080, 60), "avc1.64002a");
  assert.equal(avcCodecFor(3840, 2160, 30), "avc1.640033");
  assert.equal(avcCodecFor(3840, 2160, 60), "avc1.640034"); // 예전 고정값 5.1 로는 4K60 불가
  assert.equal(avcCodecFor(2688, 1512, 100), "avc1.640034");
});

test("비트레이트는 20~120 Mbps 안에서 화소율에 비례", () => {
  assert.equal(bitrateFor(1920, 1080, 30), 20e6);
  assert.ok(bitrateFor(3840, 2160, 60) > 70e6 && bitrateFor(3840, 2160, 60) < 80e6);
  assert.equal(bitrateFor(7680, 4320, 60), 120e6);
});

const log = (start: number, duration: number): FlightLog => ({ name: "x", version: 14, start, duration, distance: 0, maxHeight: 0, maxSpeed: 0, maxVSpeed: 0, videoTime: 0, lat: 0, lon: 0, aircraft: "", aircraftSn: "" });

test("영상과 가장 많이 겹치는 비행기록을 고른다", () => {
  const a = log(0, 100), b = log(90_000, 600);
  assert.equal(matchLog([a, b], 95_000, 200_000), b);
  assert.equal(matchLog([a, b], 10_000, 50_000), a);
  // 겹침 없어도 2분 안이면 가장 가까운 것, 멀면 없음
  assert.equal(matchLog([a], 160_000, 170_000), a);
  assert.equal(matchLog([a], 400_000, 410_000), null);
});
