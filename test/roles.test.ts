import { test } from "node:test";
import assert from "node:assert/strict";
import { detectAircraft, detectRoles, migratePicks } from "../src/roles.ts";

test("Avata2 구조", () => {
  const g = detectRoles(["aircraft_raw", "google_raw", "aircraft_merged"], { rawAtTop: false, externalGoggles: false });
  assert.equal(g.droneRaw, "aircraft_raw");
  assert.equal(g.gogglesRaw, "google_raw");
  assert.deepEqual(g.droneMerged, { name: "aircraft_merged", create: false });
  assert.deepEqual(g.gogglesMerged, { name: "google_merged", create: true });
  assert.deepEqual(g.hud, { name: "hud", create: true });
  assert.equal(g.logs, null);
  assert.deepEqual(g.legacy, []);
  assert.equal(g.excluded, null);
  assert.equal(g.gogglesExtra, null);
});

test("예전 구조: 원본이 맨 위, 결과는 2_ready", () => {
  const g = detectRoles(["2_ready", "3_uploaded", "_sources", "_excluded", "goggles"], { rawAtTop: true, externalGoggles: true });
  assert.equal(g.droneRaw, ".");
  assert.deepEqual([g.droneMerged, g.gogglesMerged, g.hud].map((x) => x.name), ["2_ready", "2_ready", "2_ready"]);
  assert.ok([g.droneMerged, g.gogglesMerged, g.hud].every((x) => !x.create));
  assert.deepEqual([...g.legacy].sort(), ["3_uploaded", "_sources"]);
  assert.equal(g.excluded, "_excluded");
  assert.equal(g.gogglesRaw, null); // 따로 연결한 고글 폴더가 역할을 가져감
  assert.equal(g.gogglesExtra, "goggles");
});

test("예전 구조 + 따로 연결한 고글 폴더 없음: goggles 가 고글 원본", () => {
  const g = detectRoles(["2_ready", "goggles"], { rawAtTop: true, externalGoggles: false });
  assert.equal(g.gogglesRaw, "goggles");
  assert.equal(g.gogglesExtra, null);
});

test("대소문자 무시, 목록 순서대로 첫 번째", () => {
  const g = detectRoles(["RAW", "Drone_Raw", "Goggles_Raw", "FlightRecords"], { rawAtTop: false, externalGoggles: false });
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
  assert.deepEqual(g.hud, { name: "hud", create: true });
});

test("raw 를 가진 하위 폴더가 기체", () => {
  const sub = [{ name: "pavopro2", hasRaw: true }, { name: "avata2", hasRaw: true }, { name: "goggles_raw", hasRaw: false }, { name: "docs", hasRaw: false }];
  assert.deepEqual(detectAircraft(sub), ["avata2", "pavopro2"]);
});

test("고글·숨김·예전 구조 이름은 기체가 아님", () => {
  assert.deepEqual(detectAircraft([{ name: "goggles", hasRaw: true }, { name: "google_x", hasRaw: true }, { name: "_old", hasRaw: true }, { name: ".x", hasRaw: true }]), []);
});

test("예전 picks 이전", () => {
  const h = {} as FileSystemDirectoryHandle, h2 = {} as FileSystemDirectoryHandle, g = {} as FileSystemDirectoryHandle;
  assert.deepEqual(migratePicks({ droneRaw: h, hud: h2, gogglesRaw: g, logs: null }), { "aircraft:default:raw": h, "aircraft:default:hud": h2, gogglesRaw: g, logs: null });
  const already = { "aircraft:avata2:raw": h };
  assert.deepEqual(migratePicks(already), already);
});
