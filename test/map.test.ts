import { test } from "node:test";
import assert from "node:assert/strict";
import { TileSource } from "../src/map.ts";
import { setLang } from "../src/i18n.ts";

test("세션 403 이면 error 가 채워지고 타일은 null", async () => {
  setLang("en");
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 403, text: async () => "Permission denied on the service." })) as any;
  try {
    const src = new TileSource("k");
    const seen: string[] = [];
    src.onError = (m) => seen.push(m);
    await src.load(0, 0, 0);
    await src.load(1, 0, 0);
    assert.equal(src.get(0, 0, 0), null);
    assert.match(src.error ?? "", /403/);
    assert.equal(seen.length, 1);
  } finally {
    globalThis.fetch = orig;
  }
});
