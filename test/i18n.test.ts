import { test } from "node:test";
import assert from "node:assert/strict";
import { setLang, t } from "../src/i18n.ts";

test("값 치환은 한 번에: 값 안의 {…}·$& 는 그대로", () => {
  setLang("en");
  assert.equal(t("err.uploadFail", { status: 400, body: "$& {status} $1" }), "Upload failed 400: $& {status} $1");
});

test("단수/복수 표기", () => {
  setLang("en");
  assert.equal(t("flight.clips", { n: 1 }), "1 clip");
  assert.equal(t("flight.clips", { n: 3 }), "3 clips");
  setLang("ko");
  assert.equal(t("flight.clips", { n: 3 }), "3개 클립");
});

test("코어 모듈 오류도 언어를 따른다", async () => {
  const { parse } = await import("../src/mp4.ts");
  const reader = { size: 16, read: async () => new Uint8Array(16) };
  setLang("en");
  await assert.rejects(parse(reader as any), /Invalid MP4 box|No moov box/);
  setLang("ko");
  await assert.rejects(parse(reader as any), /잘못된 MP4 박스|moov 박스 없음/);
});

test("모든 언어: 키와 {자리표시자}가 영어와 같다", async () => {
  const { dictionaries } = await import("../src/i18n.ts");
  const holes = (s: string) => [...s.matchAll(/\{(\w+)(?:\|[^}]*)?\}/g)].map((m) => m[1]).sort().filter((v, i, a) => a.indexOf(v) === i).join(",");
  const en = dictionaries.en;
  for (const [lang, d] of Object.entries(dictionaries)) {
    assert.deepEqual(Object.keys(d).sort(), Object.keys(en).sort(), `${lang} keys`);
    for (const k of Object.keys(en) as (keyof typeof en)[]) assert.equal(holes(d[k]), holes(en[k]), `${lang} ${k}`);
  }
});
