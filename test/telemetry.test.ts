// 실제 파일의 djmd 값이 SRT(위도/경도/상대고도)와 일치하는지 확인
import { test } from "node:test";
import assert from "node:assert/strict";
import { open, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readTelemetry, sampleAt } from "../src/telemetry.ts";

const root = process.env.DJI_TEST_DIR ?? new URL("../..", import.meta.url).pathname;
// 앱에서 병합하면 원본이 _sources 로 이동
const dir = [root, join(root, "_sources")].find((d) => existsSync(join(d, "DJI_20261011172445_0015_D.SRT"))) ?? root;
const name = "DJI_20261011172445_0015_D";

test("djmd 텔레메트리 = SRT", { skip: !existsSync(join(dir, `${name}.SRT`)) }, async () => {
  const fh = await open(join(dir, `${name}.MP4`));
  const { size } = await fh.stat();
  const tel = await readTelemetry({
    size,
    read: async (o, l) => {
      const b = new Uint8Array(l);
      await fh.read(b, 0, l, o);
      return b;
    },
  });
  await fh.close();
  assert.ok(tel.t.length > 1900);

  const srt = await readFile(join(dir, `${name}.SRT`), "utf8");
  const blocks = srt.split(/\r?\n\r?\n/).filter(Boolean);
  let checked = 0;
  for (const blk of blocks.filter((_, i) => i % 50 === 1)) {
    const m = /(\d\d):(\d\d):(\d\d),(\d+) -->[\s\S]*latitude: ([\d.-]+)\] \[longitude: ([\d.-]+)\] \[rel_alt: ([\d.-]+)/.exec(blk);
    if (!m) continue;
    const t = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
    const s = sampleAt(tel, t)!;
    assert.ok(Math.abs(s.lat - +m[5]) < 2e-5, `lat ${s.lat} vs ${m[5]} @${t}`);
    assert.ok(Math.abs(s.lon - +m[6]) < 2e-5, `lon ${s.lon} vs ${m[6]} @${t}`);
    assert.ok(Math.abs(s.relAlt - +m[7]) < 0.6, `alt ${s.relAlt} vs ${m[7]} @${t}`);
    assert.ok(Math.abs(s.pitch) < 90 && Math.abs(s.roll) < 180);
    checked++;
  }
  assert.ok(checked > 5);
});
