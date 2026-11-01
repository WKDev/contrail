// 실제 DJI 파일로 병합 결과를 ffprobe/ffmpeg 로 검증한다.
// DJI_TEST_DIR 미지정 시 상위 폴더 사용. 출력은 TMPDIR 에 생성 후 삭제.
import { test } from "node:test";
import assert from "node:assert/strict";
import { open, unlink } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { merge, parse, type Reader } from "../src/mp4.ts";

const root = process.env.DJI_TEST_DIR ?? new URL("../..", import.meta.url).pathname;
// 앱에서 병합하면 원본이 _sources 로 이동하므로 두 곳 모두 확인
const locate = (f: string) => [root, join(root, "_sources")].map((d) => join(d, f)).find(existsSync) ?? join(root, f);

async function reader(path: string): Promise<Reader & { close(): Promise<void> }> {
  const fh = await open(path);
  const { size } = await fh.stat();
  return {
    size,
    async read(offset, length) {
      const b = new Uint8Array(length);
      await fh.read(b, 0, length, offset);
      return b;
    },
    close: () => fh.close(),
  };
}

const probe = (f: string, entries: string) =>
  execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", entries, "-of", "csv=p=0", f])
    .toString()
    .trim();

for (const [a, b] of [
  ["DJI_20261030173918_0018_D.MP4", "DJI_20261030173932_0019_D.MP4"], // 작은 파일 (빠름)
  ["DJI_20261011171705_0014_D.MP4", "DJI_20261011172445_0015_D.MP4"], // 4GB 넘는 오프셋 (co64)
]) {
  test(`merge ${a} + ${b}`, { skip: !existsSync(locate(a)) }, async () => {
    const ra = await reader(locate(a));
    const rb = await reader(locate(b));
    const out = join(tmpdir(), `merge-test-${Date.now()}.mp4`);
    const ws = createWriteStream(out);
    const res = await merge([ra, rb], {
      write: (c) => new Promise((ok, err) => ws.write(c, (e) => (e ? err(e) : ok()))),
    });
    await new Promise((ok) => ws.end(ok));
    await ra.close();
    await rb.close();
    try {
      const pa = Number(probe(locate(a), "stream=nb_read_packets"));
      const pb = Number(probe(locate(b), "stream=nb_read_packets"));
      assert.equal(Number(probe(out, "stream=nb_read_packets")), pa + pb);
      const dur = Number(probe(out, "stream=duration"));
      assert.ok(Math.abs(dur - res.duration) < 0.05, `duration ${dur} vs ${res.duration}`);
      // 시작/경계/끝 부분 디코드 오류 없는지
      const ra2 = await reader(locate(a));
      const A = (await parse(ra2)).duration;
      await ra2.close();
      for (const ss of [0, A - 1, dur - 2]) {
        const r = spawnSync("ffmpeg", ["-v", "error", "-ss", String(Math.max(0, ss)), "-i", out, "-t", "2", "-f", "null", "-"]);
        assert.equal(r.status, 0);
        assert.equal(r.stderr.toString(), "");
      }
    } finally {
      await unlink(out);
    }
  });
}
