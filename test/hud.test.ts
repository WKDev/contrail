import { test } from "node:test";
import assert from "node:assert/strict";
import { addWidget, applyTemplate, applyTheme, THEMES, TEMPLATES, widgetsOf } from "../src/hud.ts";
import { defaultLayout } from "../src/store.ts";

test("예전 배치는 위젯 4개로 바뀐다 (방위계 모양은 테마를 따름)", () => {
  const L = defaultLayout();
  assert.deepEqual(widgetsOf(L).map((w) => w.kind), ["attitude", "compass", "map", "readouts"]);
  assert.equal(widgetsOf({ ...L, style: "mono" })[1].kind, "tape");
});

test("테마는 모양만, 템플릿은 위젯 구성을 바꾼다", () => {
  const a = addWidget(defaultLayout(), "speed").layout;
  const b = applyTheme(a, "sunset");
  assert.equal(b.style, "sunset");
  assert.deepEqual(b.widgets, a.widgets);
  const c = applyTemplate(b, "minimal");
  assert.deepEqual(c.widgets!.map((w) => w.kind), ["speed", "alt"]);
  assert.equal(c.style, "sunset");
});

test("모든 테마의 기본 배치 템플릿이 존재한다", () => {
  assert.equal(THEMES.length, 15);
  for (const th of THEMES) assert.ok(TEMPLATES.some((t) => t.id === th.layout), th.id);
});
