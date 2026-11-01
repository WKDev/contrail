// HUD 위젯(자세계·방위계·미니맵·수치 등)을 캔버스에 그린다. 테마(THEMES) 15종 = 모양, 배치 템플릿(TEMPLATES) = 위젯 구성.
import type { TelemetryPoint } from "./telemetry.ts";
import { drawMap, homeDistance, type TileSource, type Track } from "./map.ts";
import { defaultLayout, type Box, type HudText, type Layout, type Widget, type WidgetKind } from "./store.ts";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const D = Math.PI / 180;

export interface HudExtras {
  t: number; // 영상 시간 (초)
  track?: Track | null; // GPS 궤적 (있으면 미니맵)
  tiles?: TileSource | null; // 지도 타일 (없으면 궤적만)
  instruments?: boolean; // false 면 미니맵 말고 모든 위젯 생략
  map?: boolean; // false 면 미니맵 생략 (궤적은 이륙 지점 거리 계산에 계속 씀)
  layout?: Layout;
}

type HudBoxes = Pick<Layout, "attitude" | "heading" | "map" | "readouts">;
export interface HudTheme {
  id: string;
  ko: string;
  en: string;
  layout: string; // 이 테마에 어울리는 기본 배치 (TEMPLATES id)
  fg: string; // 선·글자
  accent: string; // 기체 심볼·포인터
  north: string;
  outline: string | null; // 글자·선 외곽 (영상 위 가독성)
  glow: number; // 발광 (0 = 없음)
  font: string;
  weight: number;
  italic?: boolean;
  sky: string | null; // 자세계 하늘/땅 (null = 선만)
  ground: string | null;
  face: string | null; // 계기 바탕
  ring: string | null; // 바깥 테두리
  line: number; // 선 굵기 배율
  heading: "rose" | "tape"; // 예전 배치를 위젯으로 바꿀 때 방위계 모양
  readouts: "line" | "chips" | "big"; // 속도·고도·상승률 줄 모양
  labels: boolean; // 계기 아래 P/R·HDG 글자
  alpha: number; // 전체 불투명도
}

const ASPECT = 16 / 9;
const g = (x: number, y: number, w: number): Box => ({ x, y, w, h: w * ASPECT });

// ---------- 위젯 ----------
export const WIDGET_INFO: Record<WidgetKind, { ko: string; en: string; round: boolean; box: Box; gps?: boolean }> = {
  attitude: { ko: "자세계", en: "Attitude", round: true, box: g(0.44, 0.38, 0.12) },
  compass: { ko: "방위계 (원형)", en: "Compass", round: true, box: g(0.44, 0.38, 0.12) },
  tape: { ko: "방위 테이프", en: "Heading tape", round: false, box: { x: 0.36, y: 0.035, w: 0.28, h: 0.06 } },
  horizon: { ko: "수평선·피치 사다리", en: "Horizon ladder", round: false, box: { x: 0.35, y: 0.3, w: 0.3, h: 0.4 } },
  map: { ko: "미니맵", en: "Minimap", round: true, box: g(0.86, 0.6, 0.12), gps: true },
  readouts: { ko: "속도·고도·상승률 줄", en: "Speed/alt/VS row", round: false, box: { x: 0.31, y: 0.795, w: 0.5, h: 0.04 } },
  speed: { ko: "속도", en: "Speed", round: false, box: { x: 0.03, y: 0.42, w: 0.11, h: 0.075 } },
  alt: { ko: "고도", en: "Altitude", round: false, box: { x: 0.86, y: 0.42, w: 0.11, h: 0.075 } },
  vs: { ko: "상승률", en: "Vertical speed", round: false, box: { x: 0.86, y: 0.51, w: 0.11, h: 0.075 } },
  dist: { ko: "이륙 지점 거리", en: "Distance home", round: false, box: { x: 0.03, y: 0.51, w: 0.11, h: 0.075 }, gps: true },
  clock: { ko: "비행 시간", en: "Flight time", round: false, box: { x: 0.03, y: 0.035, w: 0.1, h: 0.06 } },
  coords: { ko: "GPS 좌표", en: "GPS position", round: false, box: { x: 0.7, y: 0.035, w: 0.27, h: 0.04 }, gps: true },
};
export const WIDGET_KINDS = Object.keys(WIDGET_INFO) as WidgetKind[];
export const isRound = (w: Widget) => WIDGET_INFO[w.kind].round;
let seq = 0;
export const newWidgetId = () => `w${Date.now().toString(36)}${(seq++).toString(36)}`;
const W_ = (kind: WidgetKind, b: Box, style?: string): Omit<Widget, "id"> => ({ kind, ...b, ...(style ? { style } : {}) });

// 배치 템플릿 (1920x1080 기준, 하단 13% 는 고글 OSD 자리로 비워 둠)
export interface HudTemplate { id: string; ko: string; en: string; widgets: Omit<Widget, "id">[] }
export const TEMPLATES: HudTemplate[] = [
  { id: "bottom", ko: "하단 계기", en: "Bottom gauges", widgets: [W_("attitude", g(0.01875, 0.6, 0.1229)), W_("compass", g(0.1594, 0.6, 0.1229)), W_("map", g(0.8583, 0.6, 0.1229)), W_("readouts", { x: 0.31, y: 0.795, w: 0.5, h: 0.04 })] },
  { id: "corners", ko: "모서리", en: "Corners", widgets: [W_("attitude", g(0.02, 0.6, 0.12)), W_("tape", { x: 0.36, y: 0.035, w: 0.28, h: 0.065 }), W_("map", g(0.86, 0.6, 0.12)), W_("readouts", { x: 0.25, y: 0.795, w: 0.5, h: 0.045 })] },
  { id: "compact", ko: "작게", en: "Compact", widgets: [W_("attitude", g(0.015, 0.69, 0.085)), W_("compass", g(0.105, 0.69, 0.085)), W_("map", g(0.9, 0.69, 0.085)), W_("readouts", { x: 0.2, y: 0.8, w: 0.3, h: 0.03 })] },
  { id: "center", ko: "가운데 계기", en: "Center", widgets: [W_("attitude", g(0.42, 0.42, 0.16)), W_("tape", { x: 0.38, y: 0.725, w: 0.24, h: 0.055 }), W_("map", g(0.86, 0.6, 0.12)), W_("readouts", { x: 0.3, y: 0.35, w: 0.4, h: 0.05 })] },
  { id: "racing", ko: "레이싱", en: "Racing", widgets: [W_("attitude", g(0.765, 0.62, 0.105)), W_("tape", { x: 0.38, y: 0.035, w: 0.24, h: 0.06 }), W_("map", g(0.88, 0.62, 0.105)), W_("readouts", { x: 0.02, y: 0.69, w: 0.3, h: 0.14 })] },
  { id: "fighter", ko: "전투기", en: "Fighter", widgets: [W_("horizon", { x: 0.33, y: 0.28, w: 0.34, h: 0.44 }), W_("tape", { x: 0.36, y: 0.035, w: 0.28, h: 0.06 }), W_("speed", { x: 0.2, y: 0.46, w: 0.1, h: 0.07 }), W_("alt", { x: 0.7, y: 0.46, w: 0.1, h: 0.07 }), W_("vs", { x: 0.7, y: 0.55, w: 0.1, h: 0.07 }), W_("clock", { x: 0.03, y: 0.035, w: 0.1, h: 0.06 })] },
  { id: "data", ko: "수치 위주", en: "Data", widgets: [W_("speed", { x: 0.03, y: 0.62, w: 0.12, h: 0.08 }), W_("alt", { x: 0.16, y: 0.62, w: 0.12, h: 0.08 }), W_("vs", { x: 0.29, y: 0.62, w: 0.12, h: 0.08 }), W_("dist", { x: 0.42, y: 0.62, w: 0.12, h: 0.08 }), W_("clock", { x: 0.03, y: 0.035, w: 0.1, h: 0.06 }), W_("coords", { x: 0.7, y: 0.035, w: 0.27, h: 0.04 }), W_("map", g(0.86, 0.6, 0.12))] },
  { id: "minimal", ko: "최소", en: "Minimal", widgets: [W_("speed", { x: 0.03, y: 0.72, w: 0.1, h: 0.07 }), W_("alt", { x: 0.87, y: 0.72, w: 0.1, h: 0.07 })] },
];
const withIds = (ws: Omit<Widget, "id">[]): Widget[] => ws.map((w) => ({ ...structuredClone(w), id: newWidgetId() }));

const SANS = `system-ui, -apple-system, "Helvetica Neue", sans-serif`;
const MONO = `ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
const base = { north: "#ff6b5b", outline: "rgba(0,0,0,0.75)", glow: 0, font: SANS, weight: 600, ring: "rgba(255,255,255,0.9)", line: 1, labels: true, alpha: 1 };

export const THEMES: HudTheme[] = [
  { ...base, id: "classic", ko: "클래식", en: "Classic", layout: "bottom", fg: "#fff", accent: "#ffd23f", sky: "rgba(46,116,204,0.82)", ground: "rgba(122,78,38,0.82)", face: "rgba(15,18,24,0.62)", heading: "rose", readouts: "line" },
  { ...base, id: "glass", ko: "글라스", en: "Glass", layout: "bottom", fg: "#fff", accent: "#7fe3ff", outline: "rgba(0,0,0,0.45)", weight: 500, sky: "rgba(110,170,255,0.32)", ground: "rgba(170,120,70,0.32)", face: "rgba(255,255,255,0.14)", ring: "rgba(255,255,255,0.55)", line: 0.8, heading: "rose", readouts: "chips" },
  { ...base, id: "mono", ko: "모노 라인", en: "Mono line", layout: "corners", fg: "rgba(255,255,255,0.95)", accent: "#fff", north: "#fff", outline: "rgba(0,0,0,0.55)", weight: 500, sky: null, ground: null, face: null, ring: "rgba(255,255,255,0.8)", line: 0.8, heading: "tape", readouts: "line", labels: false },
  { ...base, id: "fighter", ko: "전투기 HUD", en: "Fighter HUD", layout: "fighter", fg: "#5dff7a", accent: "#5dff7a", north: "#5dff7a", outline: null, glow: 6, font: MONO, sky: null, ground: null, face: null, ring: "#5dff7a", heading: "tape", readouts: "line" },
  { ...base, id: "amber", ko: "앰버 계기", en: "Amber avionics", layout: "bottom", fg: "#ffb43a", accent: "#ffe08a", north: "#ff6b3a", outline: "rgba(0,0,0,0.7)", glow: 3, font: MONO, sky: null, ground: null, face: "rgba(10,8,4,0.5)", ring: "#ffb43a", heading: "rose", readouts: "line" },
  { ...base, id: "racing", ko: "레이싱", en: "Racing", layout: "racing", fg: "#fff", accent: "#ff3b3b", north: "#ff3b3b", weight: 800, italic: true, sky: "rgba(30,110,230,0.85)", ground: "rgba(140,80,30,0.85)", face: "rgba(10,10,14,0.7)", ring: "#ff3b3b", line: 1.2, heading: "tape", readouts: "big", labels: false },
  { ...base, id: "cinema", ko: "시네마 미니멀", en: "Cinema minimal", layout: "compact", fg: "#fff", accent: "#fff", north: "#fff", outline: "rgba(0,0,0,0.35)", weight: 400, sky: "rgba(255,255,255,0.1)", ground: "rgba(0,0,0,0.25)", face: "rgba(0,0,0,0.25)", ring: "rgba(255,255,255,0.5)", line: 0.6, heading: "rose", readouts: "line", labels: false, alpha: 0.85 },
  { ...base, id: "pfd", ko: "글래스 콕핏", en: "Glass cockpit", layout: "center", fg: "#fff", accent: "#ffd23f", north: "#ff4fd8", sky: "rgba(42,125,225,0.9)", ground: "rgba(138,90,43,0.9)", face: "rgba(8,10,14,0.78)", ring: "rgba(255,255,255,0.9)", heading: "tape", readouts: "chips" },
  { ...base, id: "neon", ko: "네온", en: "Neon", layout: "bottom", fg: "#ff4fd8", accent: "#37f3ff", north: "#37f3ff", outline: null, glow: 10, sky: null, ground: null, face: "rgba(20,0,40,0.35)", ring: "#37f3ff", heading: "rose", readouts: "chips" },
  { ...base, id: "contrast", ko: "고대비", en: "High contrast", layout: "bottom", fg: "#ffe600", accent: "#ffe600", north: "#fff", outline: "#000", weight: 800, sky: "rgba(0,0,0,0.8)", ground: "rgba(70,60,0,0.85)", face: "rgba(0,0,0,0.8)", ring: "#ffe600", line: 1.5, heading: "rose", readouts: "chips" },
  // 추가 5종
  { ...base, id: "tactical", ko: "택티컬", en: "Tactical", layout: "corners", fg: "#d9e6c4", accent: "#ff9f1c", north: "#ff9f1c", outline: "rgba(0,0,0,0.6)", font: MONO, weight: 600, sky: "rgba(70,88,60,0.55)", ground: "rgba(60,48,30,0.6)", face: "rgba(18,24,14,0.6)", ring: "#8fa66b", line: 1, heading: "tape", readouts: "chips" },
  { ...base, id: "blueprint", ko: "블루프린트", en: "Blueprint", layout: "center", fg: "#d6ecff", accent: "#ffffff", north: "#7fd0ff", outline: null, glow: 2, font: MONO, weight: 500, sky: null, ground: null, face: "rgba(12,48,104,0.55)", ring: "#8cc8ff", line: 0.7, heading: "tape", readouts: "line" },
  { ...base, id: "sunset", ko: "선셋", en: "Sunset", layout: "bottom", fg: "#ffe2c4", accent: "#ff7a59", north: "#ff7a59", outline: "rgba(40,8,20,0.6)", weight: 600, sky: "rgba(255,138,92,0.45)", ground: "rgba(92,34,70,0.55)", face: "rgba(48,14,36,0.45)", ring: "#ffb48f", line: 0.9, heading: "rose", readouts: "chips" },
  { ...base, id: "paper", ko: "화이트 카드", en: "White card", layout: "data", fg: "#14171c", accent: "#2f6bff", north: "#e5484d", outline: null, weight: 650, sky: "rgba(120,170,240,0.95)", ground: "rgba(196,160,118,0.95)", face: "rgba(255,255,255,0.88)", ring: "rgba(255,255,255,0.95)", line: 0.9, heading: "rose", readouts: "chips" },
  { ...base, id: "sport", ko: "스포츠", en: "Sport", layout: "minimal", fg: "#fff", accent: "#00e0a4", north: "#00e0a4", outline: "rgba(0,0,0,0.5)", weight: 800, italic: true, sky: null, ground: null, face: null, ring: "#00e0a4", line: 1.1, heading: "tape", readouts: "big", labels: false },
];
export const themeOf = (L?: Pick<Layout, "style">, id?: string) => THEMES.find((t) => t.id === (id ?? L?.style)) ?? THEMES[0];

// 위젯 목록: 저장된 위젯, 없으면 예전 상자 배치에서 만든다
export function widgetsOf(L: Layout): Widget[] {
  if (L.widgets) return L.widgets;
  const th = themeOf(L);
  return [
    { id: "attitude", kind: "attitude", ...L.attitude },
    { id: "heading", kind: th.heading === "rose" ? "compass" : "tape", ...L.heading },
    { id: "map", kind: "map", ...L.map },
    { id: "readouts", kind: "readouts", ...L.readouts },
  ];
}
export const templateOf = (id: string) => TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
// 테마 고르기 = 모양만 바꿈 (위젯·위치는 그대로)
export const applyTheme = (L: Layout, id: string): Layout => ({ ...L, widgets: widgetsOf(L), style: id });
// 배치 템플릿 = 위젯 구성·위치를 통째로 바꿈 (위젯별 스타일은 초기화)
export const applyTemplate = (L: Layout, id: string): Layout => ({ ...L, widgets: withIds(templateOf(id).widgets) });
export const addWidget = (L: Layout, kind: WidgetKind): { layout: Layout; id: string } => {
  const id = newWidgetId();
  return { layout: { ...L, widgets: [...widgetsOf(L), { id, kind, ...structuredClone(WIDGET_INFO[kind].box) }] }, id };
};

// 상자 → 원형 계기 중심/반지름 (상자 안에 들어가는 가장 큰 원)
export function gaugeGeom(b: Box, W: number, H: number) {
  const R = (Math.min(b.w * W, b.h * H) / 2) * 0.95;
  return { cx: (b.x + b.w / 2) * W, cy: (b.y + b.h / 2) * H, R, s: R / 118 };
}

export function drawHud(ctx: Ctx, W: number, H: number, p: TelemetryPoint, extras?: HudExtras) {
  const L = extras?.layout ?? defaultLayout();
  const inst = extras?.instruments !== false;
  for (const w of widgetsOf(L)) {
    if (w.kind === "map" ? extras?.map === false || !extras?.track?.t.length : !inst) continue;
    drawWidget(ctx, W, H, w, themeOf(L, w.style), L.text, p, extras);
  }
}

function drawWidget(ctx: Ctx, W: number, H: number, w: Widget, th: HudTheme, text: HudText | undefined, p: TelemetryPoint, extras?: HudExtras) {
  ctx.save();
  ctx.globalAlpha *= th.alpha;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const lb: Lb = (s, x, y, size, align = "center", color = th.fg) => label(ctx, th, s, x, y, size, align, color);
  const tx = { num: text?.num ?? "mono", scale: text?.scale ?? 1, color: text?.color || th.fg, segBg: !!text?.segBg } as TextOpts;
  const row = (fields: Field[], x: number, y: number, size: number, align: "center" | "left" = "center", maxW = Infinity) => fieldRow(ctx, th, tx, fields, x, y, size * tx.scale, align, maxW);
  const sg = (v: number, d = 0) => `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(d)}`;
  const X = w.x * W, Y = w.y * H, BW = w.w * W, BH = w.h * H;
  switch (w.kind) {
    case "attitude": {
      const a = gaugeGeom(w, W, H);
      attitude(ctx, th, a.cx, a.cy, a.R, p.pitch, p.roll, a.s, lb);
      if (th.labels) row([{ label: "P", value: sg(p.pitch), unit: "°", tpl: "+00" }, { label: "R", value: sg(p.roll), unit: "°", tpl: "+000" }], a.cx, a.cy + a.R + 26 * a.s, 20 * a.s);
      break;
    }
    case "compass": {
      const h = gaugeGeom(w, W, H);
      rose(ctx, th, h.cx, h.cy, h.R, p.heading, h.s, lb);
      if (th.labels) row([{ label: "HDG", value: hdg3(p.heading), unit: "°", tpl: "000" }], h.cx, h.cy + h.R + 26 * h.s, 20 * h.s);
      break;
    }
    case "tape":
      tape(ctx, th, tx, X, Y, BW, BH, p.heading, lb);
      break;
    case "horizon":
      horizon(ctx, th, X, Y, BW, BH, p.pitch, p.roll, lb);
      break;
    case "map": {
      const m = gaugeGeom(w, W, H);
      drawMap(ctx, m.cx, m.cy, m.R, m.s, extras!.track!, extras!.t, p.heading, extras!.tiles ?? null, (s, x, y, size, align, color) => lb(s, x, y, size, align, color), {
        face: th.face ?? "rgba(0,0,0,0.25)", ring: th.ring, track: th.id === "classic" ? "#4fd1ff" : th.accent === th.fg ? th.fg : th.accent, accent: th.accent, north: th.north, line: th.line,
      });
      break;
    }
    case "readouts":
      readouts(ctx, th, tx, X, Y, BW, BH, p, row);
      break;
    case "speed":
      stat(ctx, th, tx, X, Y, BW, BH, "SPD", { value: (p.speed * 3.6).toFixed(0), unit: "km/h", tpl: "000" });
      break;
    case "alt":
      stat(ctx, th, tx, X, Y, BW, BH, "ALT", { value: Number.isNaN(p.relAlt) ? "--" : p.relAlt.toFixed(1), unit: "m", tpl: "-000.0" });
      break;
    case "vs":
      stat(ctx, th, tx, X, Y, BW, BH, "VS", { value: sg(-p.vz, 1), unit: "m/s", tpl: "+00.0" });
      break;
    case "dist": {
      const d = homeDistance(extras?.track, p.lat, p.lon);
      stat(ctx, th, tx, X, Y, BW, BH, "HOME", Number.isNaN(d) ? { value: "--", unit: "m", tpl: "0000" } : d >= 1000 ? { value: (d / 1000).toFixed(2), unit: "km", tpl: "00.00" } : { value: d.toFixed(0), unit: "m", tpl: "0000" });
      break;
    }
    case "clock": {
      const s = Math.max(0, Math.floor(extras?.t ?? 0));
      stat(ctx, th, { ...tx }, X, Y, BW, BH, "TIME", { value: `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`, tpl: "00:00" });
      break;
    }
    case "coords": {
      const ok = !Number.isNaN(p.lat) && !(p.lat === 0 && p.lon === 0);
      const v = ok ? `${Math.abs(p.lat).toFixed(5)}${p.lat >= 0 ? "N" : "S"} ${Math.abs(p.lon).toFixed(5)}${p.lon >= 0 ? "E" : "W"}` : "NO GPS";
      panel(ctx, th, X, Y, BW, BH);
      lb(v, X + BW / 2, Y + BH / 2, Math.min(BH * 0.55, BW / (v.length * 0.62)) * tx.scale, "center", tx.color);
      break;
    }
  }
  ctx.restore();
}

// 수치 위젯 바탕: 테마 바탕색이 있으면 둥근 판
function panel(ctx: Ctx, th: HudTheme, x: number, y: number, w: number, h: number) {
  if (!th.face) return;
  const r = Math.min(h * 0.28, w * 0.2);
  ctx.save();
  ctx.fillStyle = th.face;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
  if (th.ring) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    strokeTwice(ctx, { ...th, outline: null }, Math.max(1, h / 40) * th.line, th.ring);
  }
  ctx.restore();
}

// 수치 하나: 위에 작은 레이블, 아래 큰 값 + 단위 (값은 고정 폭 칸에 오른쪽 정렬)
function stat(ctx: Ctx, th: HudTheme, tx: TextOpts, x: number, y: number, w: number, h: number, name: string, f: Field) {
  panel(ctx, th, x, y, w, h);
  const pad = Math.min(w, h) * 0.14;
  label(ctx, th, name, x + pad, y + h * 0.26, h * 0.22, "left", labelColor(th));
  const size = h * 0.48 * tx.scale;
  const fw = measure(ctx, th, tx, f, size).total;
  const fit = Math.min(1, (w - pad * 2) / Math.max(1, fw));
  fieldRow(ctx, th, tx, [f], x + w - pad - fw * fit, y + h * 0.66, size * fit, "left", w - pad * 2);
}

// 전투기식 수평선 + 피치 사다리 (상자 안으로 잘라 그림)
function horizon(ctx: Ctx, th: HudTheme, x: number, y: number, w: number, h: number, pitch: number, roll: number, lb: Lb) {
  const cx = x + w / 2, cy = y + h / 2;
  const ppd = h / 50; // 1도 = 상자 높이/50
  const s = h / 300;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.translate(cx, cy);
  ctx.rotate(-roll * D);
  ctx.translate(0, pitch * ppd);
  for (let d = -40; d <= 40; d += 10) {
    const yy = -d * ppd;
    const half = d === 0 ? w * 0.48 : w * 0.16;
    const gap = d === 0 ? w * 0.08 : w * 0.06;
    ctx.beginPath();
    ctx.moveTo(-half, yy);
    ctx.lineTo(-gap, yy);
    ctx.moveTo(gap, yy);
    ctx.lineTo(half, yy);
    if (d < 0) ctx.setLineDash([8 * s, 6 * s]);
    strokeTwice(ctx, th, (d === 0 ? 3 : 2) * s * th.line * 1.4, th.fg);
    ctx.setLineDash([]);
    if (d !== 0) {
      lb(String(Math.abs(d)), -half - 14 * s, yy, 16 * s, "right");
      lb(String(Math.abs(d)), half + 14 * s, yy, 16 * s, "left");
    }
  }
  ctx.restore();
  // 기체 심볼 (고정)
  ctx.save();
  ctx.translate(cx, cy);
  ctx.beginPath();
  ctx.moveTo(-w * 0.1, 0);
  ctx.lineTo(-w * 0.035, 0);
  ctx.lineTo(0, 14 * s);
  ctx.lineTo(w * 0.035, 0);
  ctx.lineTo(w * 0.1, 0);
  strokeTwice(ctx, th, 3.5 * s * th.line * 1.4, th.accent);
  ctx.restore();
}

type Lb = (text: string, x: number, y: number, size: number, align?: CanvasTextAlign, color?: string) => void;

function label(ctx: Ctx, th: HudTheme, text: string, x: number, y: number, size: number, align: CanvasTextAlign, color: string) {
  ctx.save();
  ctx.font = `${th.italic ? "italic " : ""}${th.weight} ${size}px ${th.font}`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  if (th.outline) {
    ctx.lineWidth = size / 5;
    ctx.strokeStyle = th.outline;
    ctx.strokeText(text, x, y);
  }
  glow(ctx, th, size / 20, color);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}
function glow(ctx: Ctx, th: HudTheme, s: number, color = th.fg) {
  if (!th.glow) return;
  ctx.shadowColor = color;
  ctx.shadowBlur = th.glow * s;
}
// 선 그리기: 외곽(가독성) → 본선
function strokeTwice(ctx: Ctx, th: HudTheme, w: number, color: string) {
  if (th.outline) {
    ctx.strokeStyle = th.outline;
    ctx.lineWidth = w + 2.5;
    ctx.stroke();
  }
  ctx.save();
  glow(ctx, th, w / 2, color);
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.stroke();
  ctx.restore();
}
function ringOf(ctx: Ctx, th: HudTheme, R: number, s: number) {
  if (!th.ring) return;
  if (th.outline) {
    ctx.strokeStyle = "rgba(20,20,20,0.85)";
    ctx.lineWidth = 6 * s * th.line;
    ctx.beginPath();
    ctx.arc(0, 0, R + 3 * s, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.save();
  glow(ctx, th, s);
  ctx.strokeStyle = th.ring;
  ctx.lineWidth = 1.5 * s * th.line;
  ctx.beginPath();
  ctx.arc(0, 0, R + 6 * s, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function attitude(ctx: Ctx, th: HudTheme, cx: number, cy: number, R: number, pitch: number, roll: number, s: number, lb: Lb) {
  const ppd = R / 32; // px per degree
  const lw = th.line * s;
  ctx.save();
  ctx.translate(cx, cy);

  // 하늘/땅 (기체 기울기 반대로 회전, pitch 만큼 이동)
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.clip();
  if (!th.sky && th.face) {
    ctx.fillStyle = th.face;
    ctx.fillRect(-R, -R, R * 2, R * 2);
  }
  ctx.rotate(-roll * D);
  const off = pitch * ppd;
  if (th.sky && th.ground) {
    ctx.fillStyle = th.sky;
    ctx.fillRect(-R * 2, -R * 4 + off, R * 4, R * 4);
    ctx.fillStyle = th.ground;
    ctx.fillRect(-R * 2, off, R * 4, R * 4);
  }
  ctx.beginPath();
  ctx.moveTo(-R * 2, off);
  ctx.lineTo(R * 2, off);
  strokeTwice(ctx, th, 2.5 * lw, th.fg);
  // 피치 사다리
  for (let deg = -60; deg <= 60; deg += 5) {
    if (!deg) continue;
    const y = off - deg * ppd;
    if (Math.abs(y) > R * 0.9) continue;
    const w = deg % 10 === 0 ? R * 0.36 : R * 0.16;
    ctx.beginPath();
    ctx.moveTo(-w / 2, y);
    ctx.lineTo(w / 2, y);
    if (!th.sky && deg < 0) ctx.setLineDash([5 * s, 4 * s]); // 선만 있는 스타일: 아래쪽은 점선
    strokeTwice(ctx, th, 2 * lw, th.fg);
    ctx.setLineDash([]);
    if (deg % 10 === 0) {
      lb(String(Math.abs(deg)), -w / 2 - 14 * s, y, 15 * s);
      lb(String(Math.abs(deg)), w / 2 + 14 * s, y, 15 * s);
    }
  }
  ctx.restore();

  // 뱅크 눈금 (고정)
  for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
    const big = a % 30 === 0;
    const r1 = R - (big ? 16 : 10) * s;
    const ang = (a - 90) * D;
    ctx.beginPath();
    ctx.moveTo(Math.cos(ang) * r1, Math.sin(ang) * r1);
    ctx.lineTo(Math.cos(ang) * R, Math.sin(ang) * R);
    strokeTwice(ctx, th, (big ? 3 : 2) * lw, th.fg);
  }
  // 뱅크 포인터 (회전)
  ctx.save();
  ctx.rotate(-roll * D);
  glow(ctx, th, s, th.accent);
  ctx.fillStyle = th.accent;
  ctx.beginPath();
  ctx.moveTo(0, -R + 18 * s);
  ctx.lineTo(-8 * s, -R + 32 * s);
  ctx.lineTo(8 * s, -R + 32 * s);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // 고정 기체 심볼
  ctx.beginPath();
  ctx.moveTo(-R * 0.55, 0);
  ctx.lineTo(-R * 0.2, 0);
  ctx.lineTo(-R * 0.1, R * 0.1);
  ctx.lineTo(0, 0);
  ctx.lineTo(R * 0.1, R * 0.1);
  ctx.lineTo(R * 0.2, 0);
  ctx.lineTo(R * 0.55, 0);
  if (th.outline) {
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = 8 * lw;
    ctx.stroke();
  }
  strokeTwice(ctx, { ...th, outline: null }, 4 * lw, th.accent);

  ringOf(ctx, th, R, s);
  ctx.restore();
}

function rose(ctx: Ctx, th: HudTheme, cx: number, cy: number, R: number, hdg: number, s: number, lb: Lb) {
  const lw = th.line * s;
  ctx.save();
  ctx.translate(cx, cy);
  if (th.face) {
    ctx.fillStyle = th.face;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.save();
  ctx.rotate(-hdg * D);
  for (let a = 0; a < 360; a += 5) {
    const big = a % 30 === 0;
    const mid = a % 10 === 0;
    const len = (big ? 16 : mid ? 11 : 6) * s;
    const ang = (a - 90) * D;
    ctx.beginPath();
    ctx.moveTo(Math.cos(ang) * (R - len), Math.sin(ang) * (R - len));
    ctx.lineTo(Math.cos(ang) * R, Math.sin(ang) * R);
    strokeTwice(ctx, { ...th, outline: null }, (big ? 2.5 : 1.5) * lw, th.fg);
    if (big) {
      const txt = ({ 0: "N", 90: "E", 180: "S", 270: "W" } as Record<number, string>)[a] ?? String(a / 10);
      ctx.save();
      ctx.rotate(a * D);
      lb(txt, 0, -R + 32 * s, (txt.length === 1 && /[NESW]/.test(txt) ? 20 : 15) * s, "center", a === 0 ? th.north : th.fg);
      ctx.restore();
    }
  }
  ctx.restore();

  // 고정 기체 심볼 + 기준 포인터
  ctx.save();
  glow(ctx, th, s, th.accent);
  ctx.fillStyle = th.accent;
  ctx.beginPath();
  ctx.moveTo(0, -R * 0.42);
  ctx.lineTo(R * 0.22, R * 0.22);
  ctx.lineTo(0, R * 0.1);
  ctx.lineTo(-R * 0.22, R * 0.22);
  ctx.closePath();
  if (th.outline) {
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = 3 * s;
    ctx.stroke();
  }
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, -R - 2 * s);
  ctx.lineTo(-8 * s, -R - 16 * s);
  ctx.lineTo(8 * s, -R - 16 * s);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  ringOf(ctx, th, R, s);
  ctx.restore();
}

// 가로 나침반 테이프: 가운데 = 현재 방위, 좌우 ±50°
function tape(ctx: Ctx, th: HudTheme, tx: TextOpts, x: number, y: number, w: number, h: number, hdg: number, lb: Lb) {
  const s = h / 60;
  const span = 50;
  const ppd = w / 2 / span;
  ctx.save();
  if (th.face) {
    ctx.fillStyle = th.face;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, h * 0.18);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.rect(x, y - h, w, h * 3);
  ctx.clip();
  const cx = x + w / 2;
  const bottom = y + h;
  const start = Math.ceil((hdg - span) / 5) * 5;
  for (let a = start; a <= hdg + span; a += 5) {
    const px = cx + (a - hdg) * ppd;
    const n = ((a % 360) + 360) % 360;
    const big = n % 30 === 0;
    const mid = n % 10 === 0;
    const len = h * (big ? 0.32 : mid ? 0.22 : 0.12);
    ctx.beginPath();
    ctx.moveTo(px, bottom - h * 0.06);
    ctx.lineTo(px, bottom - h * 0.06 - len);
    strokeTwice(ctx, th, (big ? 2.4 : 1.5) * s * th.line, th.fg);
    if (big) {
      const txt = ({ 0: "N", 90: "E", 180: "S", 270: "W" } as Record<number, string>)[n] ?? String(n / 10);
      // 가장자리로 갈수록 흐리게
      ctx.save();
      ctx.globalAlpha *= 1 - Math.min(1, Math.abs(a - hdg) / span) ** 2 * 0.8;
      lb(txt, px, y + h * 0.36, h * (/[NESW]/.test(txt) ? 0.34 : 0.28), "center", n === 0 ? th.north : th.fg);
      ctx.restore();
    }
  }
  ctx.restore();
  // 가운데 현재 값
  const bw = h * 1.5, bh = h * 0.5;
  ctx.save();
  ctx.fillStyle = th.face ? "rgba(0,0,0,0.75)" : "rgba(0,0,0,0.35)";
  ctx.beginPath();
  ctx.roundRect(cx - bw / 2, y - bh * 0.65, bw, bh, bh * 0.2);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(cx - bw / 2, y - bh * 0.65, bw, bh, bh * 0.2);
  strokeTwice(ctx, { ...th, outline: null }, 1.5 * s * th.line, th.accent);
  ctx.restore();
  fieldRow(ctx, th, tx, [{ value: hdg3(hdg), unit: "°", tpl: "000" }], cx, y - bh * 0.65 + bh / 2, bh * 0.7, "center", bw * 0.9);
  // 아래쪽 포인터
  ctx.save();
  glow(ctx, th, s, th.accent);
  ctx.fillStyle = th.accent;
  ctx.beginPath();
  ctx.moveTo(cx, bottom - h * 0.1);
  ctx.lineTo(cx - h * 0.12, bottom + h * 0.1);
  ctx.lineTo(cx + h * 0.12, bottom + h * 0.1);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function readouts(ctx: Ctx, th: HudTheme, tx: TextOpts, x: number, y: number, w: number, h: number, p: TelemetryPoint, row: (f: Field[], x: number, y: number, size: number, align?: "center" | "left", maxW?: number) => void) {
  const spd: Field = { label: "SPD", value: (p.speed * 3.6).toFixed(0), unit: "km/h", tpl: "000" };
  const alt: Field | null = Number.isNaN(p.relAlt) ? null : { label: "ALT", value: p.relAlt.toFixed(1), unit: "m", tpl: "-000.0" };
  // DJI 속도는 NED (z 양수 = 하강)
  const vs: Field = { label: "VS", value: `${-p.vz >= 0 ? "+" : "-"}${Math.abs(p.vz).toFixed(1)}`, unit: "m/s", tpl: "+00.0" };
  const all = [spd, ...(alt ? [alt] : []), vs];
  if (th.readouts === "line") return row(all, x + w / 2, y + h / 2, h * 0.6, "center", w);
  if (th.readouts === "chips") {
    const gap = h * 0.3;
    const cw = (w - gap * (all.length - 1)) / all.length;
    all.forEach((f, i) => {
      const cx = x + i * (cw + gap);
      ctx.save();
      ctx.fillStyle = th.face ?? "rgba(0,0,0,0.4)";
      ctx.beginPath();
      ctx.roundRect(cx, y, cw, h, h / 2);
      ctx.fill();
      if (th.ring) {
        ctx.beginPath();
        ctx.roundRect(cx, y, cw, h, h / 2);
        strokeTwice(ctx, { ...th, outline: null }, Math.max(1, h / 30) * th.line, th.ring);
      }
      ctx.restore();
      // 칩 안: 레이블은 왼쪽 끝, 값+단위는 오른쪽 끝 고정
      fieldRow(ctx, th, tx, [f], cx + h * 0.45, y + h / 2, h * 0.5 * tx.scale, "spread", cw - h * 0.9);
    });
    return;
  }
  // big: 속도 크게 + 고도·상승률 작게
  fieldRow(ctx, th, tx, [{ value: spd.value, unit: "km/h", tpl: "000" }], x, y + h * 0.4, h * 0.6 * tx.scale, "left", w);
  row(alt ? [alt, vs] : [vs], x, y + h * 0.88, h * 0.2, "left", w);
}

// ---------- 숫자 칸 ----------
// [레이블][     값][단위]: 값은 tpl(가장 긴 모양) 너비의 칸에 오른쪽 정렬 → 자릿수가 바뀌어도 레이블·단위 위치가 고정
export interface Field {
  label?: string;
  value: string;
  unit?: string;
  tpl: string;
}
type TextOpts = { num: "mono" | "seg7" | "theme"; scale: number; color: string; segBg?: boolean };
const fontOf = (th: HudTheme, size: number, family = th.font, weight = th.weight) => `${th.italic ? "italic " : ""}${weight} ${size}px ${family}`;
const labelColor = (th: HudTheme) => (th.accent !== th.fg ? th.accent : th.fg);

function valueWidth(ctx: Ctx, th: HudTheme, tx: TextOpts, tpl: string, size: number) {
  if (tx.num === "seg7") return [...tpl].reduce((a, c) => a + segCell(c, size), 0);
  ctx.font = fontOf(th, size, tx.num === "mono" ? MONO : th.font, tx.num === "mono" ? Math.max(500, th.weight) : th.weight);
  return ctx.measureText(tpl.replace(/[0-9]/g, "0")).width;
}
function measure(ctx: Ctx, th: HudTheme, tx: TextOpts, f: Field, size: number) {
  ctx.save();
  const ls = size * 0.58;
  ctx.font = fontOf(th, ls);
  const lw = f.label ? ctx.measureText(f.label).width + size * 0.3 : 0;
  const uw = f.unit ? (ctx.measureText(f.unit).width + size * (f.unit === "°" ? 0.04 : 0.16)) : 0;
  const vw = valueWidth(ctx, th, tx, f.tpl, size);
  ctx.restore();
  return { lw, vw, uw, total: lw + vw + uw };
}
// align: center = 가운데 기준 / left = x 부터 / spread = 레이블은 x, 값+단위는 x+maxW 에 붙임
function fieldRow(ctx: Ctx, th: HudTheme, tx: TextOpts, fields: Field[], x: number, cy: number, size: number, align: "center" | "left" | "spread", maxW = Infinity) {
  const gap = size * 0.9;
  let ms = fields.map((f) => measure(ctx, th, tx, f, size));
  let total = ms.reduce((a, m) => a + m.total, 0) + gap * (fields.length - 1);
  if (total > maxW) {
    // 상자보다 넓으면 줄여서 맞춤
    const k = maxW / total;
    size *= k;
    ms = fields.map((f) => measure(ctx, th, tx, f, size));
    total *= k;
  }
  let px = align === "center" ? x - total / 2 : x;
  fields.forEach((f, i) => {
    const m = ms[i];
    const ls = size * 0.58;
    if (f.label) label(ctx, th, f.label, px, cy, ls, "left", labelColor(th));
    const vRight = align === "spread" ? x + maxW - m.uw : px + m.lw + m.vw;
    if (tx.num === "seg7" && tx.segBg) segPlate(ctx, vRight - m.vw, cy, m.vw, size);
    drawValue(ctx, th, tx, f.value, vRight, cy, size);
    if (f.unit) label(ctx, th, f.unit, vRight + (f.unit === "°" ? size * 0.04 : size * 0.16), cy + (f.unit === "°" ? -size * 0.12 : size * 0.06), ls, "left", tx.color);
    px += m.total + gap;
  });
}
function drawValue(ctx: Ctx, th: HudTheme, tx: TextOpts, v: string, right: number, cy: number, size: number) {
  if (tx.num === "seg7") return seg7(ctx, th, v, right, cy, size, tx.color);
  ctx.save();
  ctx.font = fontOf(th, size, tx.num === "mono" ? MONO : th.font, tx.num === "mono" ? Math.max(500, th.weight) : th.weight);
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  if (th.outline) {
    ctx.lineWidth = size / 5;
    ctx.strokeStyle = th.outline;
    ctx.strokeText(v, right, cy);
  }
  glow(ctx, th, size / 20, tx.color);
  ctx.fillStyle = tx.color;
  ctx.fillText(v, right, cy);
  ctx.restore();
}

// 7-세그먼트: 꺼진 칸도 희미하게 그려 계기판 느낌
const SEGS: Record<string, string> = {
  "0": "abcdef", "1": "bc", "2": "abged", "3": "abgcd", "4": "fgbc", "5": "afgcd", "6": "afgedc", "7": "abc", "8": "abcdefg", "9": "abcfgd", "-": "g", "+": "g|", " ": "",
};
// 7-세그먼트 뒤 검은 판 (LCD 창처럼): 가장 긴 값 칸 너비로 고정해 자릿수가 바뀌어도 판 크기 유지
function segPlate(ctx: Ctx, x: number, cy: number, w: number, size: number) {
  const px = size * 0.16, h = size * 1.12;
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.82)";
  ctx.beginPath();
  ctx.roundRect(x - px, cy - h / 2, w + px * 2, h, size * 0.14);
  ctx.fill();
  ctx.restore();
}
const segCell = (c: string, size: number) => (c === "." ? size * 0.26 : size * 0.62);
function seg7(ctx: Ctx, th: HudTheme, v: string, right: number, cy: number, size: number, color: string) {
  const h = size * 0.86, w = size * 0.48, t = size * 0.11;
  let x = right;
  ctx.save();
  for (const c of [...v].reverse()) {
    const cw = segCell(c, size);
    x -= cw;
    const ox = x + (cw - w) / 2 + size * 0.04, oy = cy - h / 2;
    if (c === ".") {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x + cw / 2, oy + h - t / 2, t * 0.6, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    const on = SEGS[c] ?? "";
    const skew = (yy: number) => (h / 2 - (yy - oy)) * 0.1; // 살짝 기울임
    const seg = (k: string, poly: [number, number][]) => {
      const lit = on.includes(k);
      if (!lit && c !== "-" && c !== "+" && !/[0-9]/.test(c)) return;
      ctx.beginPath();
      poly.forEach(([px, py], i) => (i ? ctx.lineTo(px + skew(py), py) : ctx.moveTo(px + skew(py), py)));
      ctx.closePath();
      if (lit) {
        if (th.outline) {
          ctx.strokeStyle = th.outline;
          ctx.lineWidth = t * 0.45;
          ctx.stroke();
        }
        ctx.save();
        glow(ctx, th, size / 20, color);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.restore();
      } else if (/[0-9]/.test(c)) {
        ctx.fillStyle = "rgba(255,255,255,0.08)";
        ctx.fill();
      }
    };
    const g = t * 0.15; // 세그먼트 사이 틈
    const hz = (yy: number): [number, number][] => [[ox + t / 2 + g, yy], [ox + t + g, yy - t / 2], [ox + w - t - g, yy - t / 2], [ox + w - t / 2 - g, yy], [ox + w - t - g, yy + t / 2], [ox + t + g, yy + t / 2]];
    const vt = (xx: number, y1: number, y2: number): [number, number][] => [[xx, y1 + g], [xx + t / 2, y1 + t / 2 + g], [xx + t / 2, y2 - t / 2 - g], [xx, y2 - g], [xx - t / 2, y2 - t / 2 - g], [xx - t / 2, y1 + t / 2 + g]];
    const top = oy + t / 2, mid = oy + h / 2, bot = oy + h - t / 2;
    const L = ox + t / 2, Rr = ox + w - t / 2;
    seg("a", hz(top));
    seg("g", hz(mid));
    seg("d", hz(bot));
    seg("f", vt(L, top, mid));
    seg("b", vt(Rr, top, mid));
    seg("e", vt(L, mid, bot));
    seg("c", vt(Rr, mid, bot));
    if (on.includes("|")) {
      ctx.fillStyle = color;
      ctx.fillRect(ox + w / 2 - t / 2 + skew(mid), mid - w * 0.32, t, w * 0.64);
    }
  }
  ctx.restore();
}

const hdg3 = (h: number) => String(Math.round(((h % 360) + 360) % 360) % 360).padStart(3, "0");
