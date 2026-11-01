import { test } from "node:test";
import assert from "node:assert/strict";
import { bestLag, refineLag, type Signal } from "../src/sync.ts";

// 같은 무작위 움직임 신호를 2.3초 어긋나게 + 잡음 → lag 복원
test("교차상관으로 지연 복원", () => {
  const dt = 0.1;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const base: number[] = [];
  let x = 0;
  for (let i = 0; i < 1200; i++) base.push((x = 0.8 * x + rnd()));
  const flight: Signal = { t0: 0, dt, v: Float32Array.from(base.slice(100, 700)) }; // flight t = (i)*dt, 원본 인덱스 i+100
  const lagTrue = 2.3; // flightTime = gogglesTime + lag
  // goggles 샘플 j 의 시간 tg = j*dt, 대응 flight 시간 = tg + lag → 원본 인덱스 = (tg+lag)/dt + 100
  const g = new Float32Array(600);
  for (let j = 0; j < 600; j++) {
    const idx = Math.round((j * dt + lagTrue) / dt) + 100;
    g[j] = (base[idx] ?? 0) * 1.7 + 3 + (rnd() - 0.5) * 0.3;
  }
  const r = bestLag(flight, { t0: 0, dt, v: g }, -10, 10);
  assert.ok(Math.abs(r.lag - lagTrue) < 0.051, `lag ${r.lag}`);
  assert.ok(r.score > 0.8, `score ${r.score}`);
  assert.ok(Math.abs(refineLag(r.curve, r.lag) - lagTrue) < 0.06);
});
