// 플레이어 위에서 바로 편집: HUD 위젯 위치·크기, 고글 OSD 잘라낼 영역(사각/원형, 가장자리 블러, 검정 제거).
// 바꾼 내용은 바로 저장되고 Ctrl+Z 로 되돌린다. 스냅: 화면 기준선·다른 위젯 가장자리·간격·원끼리 맞닿기·같은 크기.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ChevronDown, Circle, Magnet, Plus, Redo2, RotateCcw, Square, Trash2, Undo2 } from "lucide-preact";
import { defaultOsd, type Box, type HudText, type Layout, type OsdMask, type Widget, type WidgetKind } from "../store.ts";
import { addWidget, applyTemplate, applyTheme, drawHud, isRound, TEMPLATES, THEMES, themeOf, WIDGET_INFO, WIDGET_KINDS, widgetsOf } from "../hud.ts";
import { snapMove, snapResize, type Corner, type SnapBox } from "../snap.ts";
import { sampleAt, type Telemetry, type TelemetryPoint } from "../telemetry.ts";
import { buildTrack } from "../map.ts";
import { getLang, t } from "../i18n.ts";

export type Sel = { kind: "hud"; id: string } | { kind: "osd"; i: number } | null;
type Handle = "move" | Corner;
export interface EditState {
  draft: Layout;
  mode: "hud" | "osd";
  sel: Sel;
  ghost: number; // OSD 편집 중 고글 화면 전체를 겹쳐 보는 불투명도
  snap: boolean;
}
export type SetEd = (fn: (e: EditState) => EditState) => void;

const ASPECT = 16 / 9;
const SNAP_PX = 9;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

// 편집 상태 + 자동 저장 + 되돌리기. mode 가 null 이면 편집하지 않음
export function useLayoutEditor(layout: Layout, save: (l: Layout) => void, mode: "hud" | "osd" | null) {
  const [ed, setEdRaw] = useState<EditState | null>(null);
  const h = useRef({ past: [] as Layout[], future: [] as Layout[], saved: null as Layout | null, latest: null as Layout | null });
  const saveRef = useRef(save);
  saveRef.current = save;
  const [, bump] = useState(0);

  const commit = (d: Layout) => {
    const H = h.current;
    if (!H.saved || d === H.saved) return;
    H.past.push(H.saved);
    if (H.past.length > 60) H.past.shift();
    H.future = [];
    H.saved = d;
    saveRef.current(d);
    bump((n) => n + 1);
  };
  useEffect(() => {
    if (!mode) {
      if (h.current.latest) commit(h.current.latest);
      return setEdRaw(null);
    }
    setEdRaw((e) => {
      if (e) return { ...e, mode, sel: null };
      h.current.saved = h.current.latest = layout;
      return { draft: structuredClone(layout), mode, sel: null, ghost: 0.45, snap: true };
    });
  }, [mode]);
  // 바뀐 배치는 손을 멈추면(0.3초) 저장
  useEffect(() => {
    if (!ed) return;
    h.current.latest = ed.draft;
    const id = setTimeout(() => commit(ed.draft), 300);
    return () => clearTimeout(id);
  }, [ed?.draft]);
  useEffect(() => () => void (h.current.latest && commit(h.current.latest)), []);

  const step = (back: boolean) => {
    const H = h.current;
    if (!ed) return;
    if (ed.draft !== H.saved) commit(ed.draft);
    const from = back ? H.past : H.future;
    const to = back ? H.future : H.past;
    const d = from.pop();
    if (!d || !H.saved) return;
    to.push(H.saved);
    H.saved = H.latest = d;
    saveRef.current(d);
    setEdRaw((e) => (e ? { ...e, draft: d, sel: null } : e));
    bump((n) => n + 1);
  };
  // Ctrl/Cmd+Z 되돌리기, Shift+Ctrl+Z · Ctrl+Y 다시
  useEffect(() => {
    if (!ed) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || (e.target as HTMLElement)?.closest?.("input, textarea, select")) return;
      const k = e.key.toLowerCase();
      if (k === "z" || k === "y") {
        e.preventDefault();
        step(k === "z" && !e.shiftKey);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const setEd: SetEd = (fn) => setEdRaw((e) => (e ? fn(e) : e));
  return {
    ed, setEd,
    undo: () => step(true), redo: () => step(false),
    canUndo: h.current.past.length > 0 || (!!ed && ed.draft !== h.current.saved), canRedo: h.current.future.length > 0,
  };
}
export type LayoutEditor = ReturnType<typeof useLayoutEditor>;

// 플레이어 화면 위에 겹치는 편집 상자들
export function EditOverlay({ ed, setEd }: { ed: EditState; setEd: SetEd }) {
  const stage = useRef<HTMLDivElement>(null);
  const [fx, setFx] = useState<{ x: number[]; y: number[]; hits: number[]; same?: number; touch?: number }>({ x: [], y: [], hits: [] });
  const { draft, mode, sel } = ed;
  const widgets = widgetsOf(draft);
  const wOf = (id: string) => widgets.find((w) => w.id === id);

  const setSel = (s: Sel) => setEd((e) => ({ ...e, sel: s }));
  const boxOf = (s: NonNullable<Sel>): Box => (s.kind === "hud" ? wOf(s.id)! : draft.osd[s.i]);
  const setBox = (s: NonNullable<Sel>, b: Box) =>
    setEd((e) => {
      const d = { ...e.draft };
      if (s.kind === "hud") d.widgets = widgetsOf(d).map((w) => (w.id === s.id ? { ...w, x: b.x, y: b.y, w: b.w, h: b.h } : w));
      else d.osd = d.osd.map((m, i) => (i === s.i ? { ...m, ...b } : m));
      return { ...e, draft: d };
    });
  // 스냅 대상 = 같은 모드의 다른 상자 (목록 인덱스 = 화면 상자 인덱스)
  const all: (SnapBox & { key: string })[] =
    mode === "hud" ? widgets.map((w) => ({ ...w, round: isRound(w), key: w.id })) : draft.osd.map((b, i) => ({ ...b, round: false, key: String(i) }));
  const keyOf = (s: NonNullable<Sel>) => (s.kind === "hud" ? s.id : String(s.i));

  function startDrag(e: PointerEvent, s: NonNullable<Sel>, handle: Handle) {
    e.stopPropagation();
    e.preventDefault();
    setSel(s);
    (e.currentTarget as HTMLElement).closest<HTMLElement>(".ebox")?.focus({ preventScroll: true });
    const st = stage.current!.getBoundingClientRect();
    const start = boxOf(s);
    const p0 = { x: e.clientX, y: e.clientY };
    const me = all.find((b) => b.key === keyOf(s));
    const round = !!me?.round;
    const others = all.filter((b) => b.key !== keyOf(s));
    const idxOf = (i: number) => all.indexOf(others[i]);
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - p0.x) / st.width;
      const dy = (ev.clientY - p0.y) / st.height;
      const useSnap = ed.snap && !ev.altKey;
      let r;
      if (handle === "move") {
        const raw = { ...start, x: clamp(start.x + dx, -start.w * 0.5, 1 - start.w * 0.5), y: clamp(start.y + dy, -start.h * 0.5, 1 - start.h * 0.5) };
        r = useSnap ? snapMove(raw, round, others, st.width, st.height, SNAP_PX) : { box: raw, gx: [], gy: [], hits: [] };
      } else r = snapResize(start, handle, dx, dy, round, others, st.width, st.height, SNAP_PX, useSnap);
      setFx({
        x: r.gx, y: r.gy, hits: r.hits.map(idxOf),
        same: r.same !== undefined ? idxOf(r.same) : undefined, touch: r.touch !== undefined ? idxOf(r.touch) : undefined,
      });
      setBox(s, r.box);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      setFx({ x: [], y: [], hits: [] });
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  // OSD: 빈 곳을 끌어 새 사각 영역. HUD: 빈 곳 누르면 선택 해제
  function startCreate(e: PointerEvent) {
    if (mode !== "osd") return setSel(null);
    const st = stage.current!.getBoundingClientRect();
    const x0 = clamp((e.clientX - st.left) / st.width, 0, 1);
    const y0 = clamp((e.clientY - st.top) / st.height, 0, 1);
    const i = draft.osd.length;
    let made = false;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const x1 = clamp((ev.clientX - st.left) / st.width, 0, 1);
      const y1 = clamp((ev.clientY - st.top) / st.height, 0, 1);
      if (!made && Math.hypot((x1 - x0) * st.width, (y1 - y0) * st.height) < 6) return;
      const b: OsdMask = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.max(0.02, Math.abs(x1 - x0)), h: Math.max(0.02, Math.abs(y1 - y0)), shape: "rect", feather: 0.004, key: true };
      setEd((s) => {
        const osd = [...s.draft.osd];
        osd[i] = made ? { ...osd[i], ...b } : b;
        return { ...s, draft: { ...s.draft, osd }, sel: { kind: "osd", i } };
      });
      made = true;
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      if (!made) setSel(null);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  }

  // 키보드: 화살표 1px (Shift 10px), Delete 로 빼기, Esc 선택 해제
  function onKey(e: KeyboardEvent) {
    if (!sel) return;
    const st = stage.current!.getBoundingClientRect();
    const step = e.shiftKey ? 10 : 1;
    const d = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, number[]>)[e.key];
    if (d) {
      e.preventDefault();
      e.stopPropagation();
      const b = boxOf(sel);
      setBox(sel, { ...b, x: b.x + d[0] / st.width, y: b.y + d[1] / st.height });
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      setEd((s) => ({
        ...s, sel: null,
        draft: sel.kind === "osd" ? { ...s.draft, osd: s.draft.osd.filter((_, k) => k !== sel.i) } : { ...s.draft, widgets: widgetsOf(s.draft).filter((w) => w.id !== sel.id) },
      }));
    } else if (e.key === "Escape") {
      e.stopPropagation();
      setSel(null);
    }
  }

  const pct = (b: Box) => ({ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });
  const handles = (s: NonNullable<Sel>) =>
    (["nw", "ne", "sw", "se"] as Corner[]).map((h) => <span class={`handle ${h}`} onPointerDown={(e) => startDrag(e as PointerEvent, s, h)} />);
  const fxClass = (i: number) => (fx.touch === i ? "touch" : fx.same === i ? "same" : fx.hits.includes(i) ? "hit" : "");
  const selIdx = sel ? all.findIndex((b) => b.key === keyOf(sel)) : -1;

  return (
    <div class={`edit-layer ${mode} ${fx.hits.length || fx.x.length || fx.y.length ? "snapping" : ""}`} ref={stage} onPointerDown={(e) => startCreate(e as PointerEvent)} onKeyDown={onKey as any} onClick={(e) => e.stopPropagation()}>
      {fx.x.map((x) => <span class="guide v" style={{ left: `${x * 100}%` }} />)}
      {fx.y.map((y) => <span class="guide h" style={{ top: `${y * 100}%` }} />)}
      {mode === "hud" &&
        widgets.map((w, i) => {
          const s: Sel = { kind: "hud", id: w.id };
          const on = sel?.kind === "hud" && sel.id === w.id;
          return (
            <div key={w.id} class={`ebox ${isRound(w) ? "round" : ""} ${on ? "on" : ""} ${fxClass(i)}`} style={pct(w)} onPointerDown={(e) => startDrag(e as PointerEvent, s, "move")} tabIndex={0} onFocus={() => !on && setSel(s)}>
              <span class="ebox-label">{widgetName(w.kind)}</span>
              {on && handles(s)}
            </div>
          );
        })}
      {mode === "osd" &&
        draft.osd.map((b, i) => {
          const s: Sel = { kind: "osd", i };
          const on = sel?.kind === "osd" && sel.i === i;
          return (
            <div class={`ebox osd ${b.shape === "ellipse" ? "ellipse" : ""} ${on ? "on" : ""} ${fxClass(i)}`} style={pct(b)} onPointerDown={(e) => startDrag(e as PointerEvent, s, "move")} tabIndex={0} onFocus={() => !on && setSel(s)}>
              <span class="ebox-label">{t("lay.area", { n: i + 1 })}</span>
              {on && handles(s)}
            </div>
          );
        })}
      {fx.same !== undefined && selIdx >= 0 && <span class="snap-badge" style={{ left: `${(all[selIdx].x + all[selIdx].w / 2) * 100}%`, top: `${(all[selIdx].y + all[selIdx].h) * 100}%` }}>{t("snap.same")}</span>}
      {fx.touch !== undefined && selIdx >= 0 && <span class="snap-badge" style={{ left: `${(all[selIdx].x + all[selIdx].w / 2) * 100}%`, top: `${(all[selIdx].y + all[selIdx].h) * 100}%` }}>{t("snap.touch")}</span>}
    </div>
  );
}

// 편집 도구줄: 스냅 · 되돌리기 · 다시 · 초기화
export function EditTools({ le, onReset, resetLabel }: { le: LayoutEditor; onReset: () => void; resetLabel: string }) {
  if (!le.ed) return null;
  return (
    <div class="edit-tools">
      <button class={`soft-btn sm ${le.ed.snap ? "active" : ""}`} aria-pressed={le.ed.snap} onClick={() => le.setEd((e) => ({ ...e, snap: !e.snap }))} title={t("lay.snapHint")}>
        <Magnet size={14} /> {t("lay.snap")}
      </button>
      <span class="spacer" />
      <button class="icon-btn sm" onClick={le.undo} disabled={!le.canUndo} aria-label={t("lay.undo")} title={`${t("lay.undo")} (Ctrl+Z)`}><Undo2 size={15} /></button>
      <button class="icon-btn sm" onClick={le.redo} disabled={!le.canRedo} aria-label={t("lay.redo")} title={`${t("lay.redo")} (Ctrl+Shift+Z)`}><Redo2 size={15} /></button>
      <button class="text-btn sm" onClick={onReset} title={resetLabel}><RotateCcw size={14} /> {t("lay.reset")}</button>
    </div>
  );
}

// 접히는 패널 구역
export function Section({ title, extra, open = true, children }: { title: preact.ComponentChildren; extra?: preact.ComponentChildren; open?: boolean; children: preact.ComponentChildren }) {
  return (
    <details class="psec" open={open}>
      <summary><ChevronDown size={14} class="psec-chev" /> <span class="psec-title">{title}</span>{extra && <span class="psec-extra">{extra}</span>}</summary>
      <div class="psec-body">{children}</div>
    </details>
  );
}

// HUD 편집: 테마 → 배치 템플릿 → 화면 위젯 → 숫자 표시
export function HudPanel({ le, tel, thumb }: { le: LayoutEditor; tel: Telemetry | null; thumb?: string }) {
  const { ed, setEd } = le;
  if (!ed) return null;
  return (
    <>
      <EditTools le={le} onReset={() => setEd((e) => ({ ...e, sel: null, draft: applyTemplate(e.draft, themeOf(e.draft).layout) }))} resetLabel={t("lay.resetHud")} />
      <p class="hint-line">{t("lay.hint")}</p>
      <WidgetList ed={ed} setEd={setEd} />
      <Section title={t("lay.theme")}>
        <StyleGallery layout={ed.draft} tel={tel} thumb={thumb} onPick={(id) => setEd((e) => ({ ...e, draft: applyTheme(e.draft, id) }))} />
      </Section>
      <Section title={t("lay.template")}>
        <p class="hint-line">{t("lay.templateHint")}</p>
        <TemplatePicker onPick={(id) => setEd((e) => ({ ...e, draft: applyTemplate(e.draft, id), sel: null }))} />
      </Section>
      <Section title={t("txt.title")}>
        <TextOptions text={ed.draft.text} onChange={(text) => setEd((e) => ({ ...e, draft: { ...e.draft, text } }))} />
      </Section>
    </>
  );
}

// 고글 OSD 영역 편집
export function OsdPanel({ le }: { le: LayoutEditor }) {
  const { ed, setEd } = le;
  if (!ed) return null;
  const { draft, sel } = ed;
  const setMask = (i: number, patch: Partial<OsdMask>) => setEd((e) => ({ ...e, draft: { ...e.draft, osd: e.draft.osd.map((m, k) => (k === i ? { ...m, ...patch } : m)) } }));
  const add = (shape: "rect" | "ellipse") =>
    setEd((e) => {
      const m: OsdMask = shape === "rect" ? { x: 0.35, y: 0.4, w: 0.3, h: 0.12, shape, feather: 0.004, key: true } : { x: 0.44, y: 0.4, w: 0.12, h: 0.12 * ASPECT, shape, feather: 0.01, key: true };
      return { ...e, draft: { ...e.draft, osd: [...e.draft.osd, m] }, sel: { kind: "osd", i: e.draft.osd.length } };
    });
  const remove = (i: number) => setEd((e) => ({ ...e, draft: { ...e.draft, osd: e.draft.osd.filter((_, k) => k !== i) }, sel: null }));
  return (
    <>
      <EditTools le={le} onReset={() => setEd((e) => ({ ...e, sel: null, draft: { ...e.draft, osd: [defaultOsd()] } }))} resetLabel={t("lay.resetOsd")} />
      <h4 class="panel-h">{t("lay.osd")}</h4>
      <p class="hint-line">{t("lay.osdHint")}</p>
      <label class="slider">
        <span>{t("lay.ghost")}</span>
        <input type="range" min={0} max={1} step={0.05} value={ed.ghost} onInput={(e) => setEd((s) => ({ ...s, ghost: Number((e.target as HTMLInputElement).value) }))} />
        <span class="num">{Math.round(ed.ghost * 100)}%</span>
      </label>
      <ul class="mask-list">
        {draft.osd.map((m, i) => {
          const on = sel?.kind === "osd" && sel.i === i;
          return (
            <li class={`mask-row ${on ? "on" : ""}`} key={i} onClick={() => setEd((e) => ({ ...e, sel: { kind: "osd", i } }))}>
              <div class="row">
                {m.shape === "ellipse" ? <Circle size={15} strokeWidth={2} /> : <Square size={15} strokeWidth={2} />}
                <b>{t("lay.area", { n: i + 1 })}</b>
                <span class="spacer" />
                <div class="seg-control neu-inset mini" role="radiogroup" aria-label={t("lay.shape")}>
                  <button role="radio" aria-checked={m.shape !== "ellipse"} class={m.shape !== "ellipse" ? "on" : ""} onClick={() => setMask(i, { shape: "rect" })}>{t("lay.rect")}</button>
                  <button role="radio" aria-checked={m.shape === "ellipse"} class={m.shape === "ellipse" ? "on" : ""} onClick={() => setMask(i, { shape: "ellipse" })}>{t("lay.ellipse")}</button>
                </div>
                <button class="icon-btn sm" aria-label={t("lay.delete")} onClick={(e) => { e.stopPropagation(); remove(i); }}><Trash2 size={14} /></button>
              </div>
              {on && (
                <>
                  <label class="slider">
                    <span>{t("lay.feather")}</span>
                    <input type="range" min={0} max={0.06} step={0.002} value={m.feather ?? 0} onInput={(e) => setMask(i, { feather: Number((e.target as HTMLInputElement).value) })} />
                    <span class="num">{Math.round((m.feather ?? 0) * 1080)}px</span>
                  </label>
                  <label class="check">
                    <input type="checkbox" checked={m.key !== false} onChange={(e) => setMask(i, { key: (e.target as HTMLInputElement).checked })} />
                    {t("lay.key")}
                  </label>
                </>
              )}
            </li>
          );
        })}
      </ul>
      <div class="row">
        <button class="soft-btn sm" onClick={() => add("rect")}><Square size={14} /> {t("lay.addRect")}</button>
        <button class="soft-btn sm" onClick={() => add("ellipse")}><Circle size={14} /> {t("lay.addEllipse")}</button>
      </div>
    </>
  );
}

// HUD 테마 15종: 지금 비행의 썸네일 + 비행 데이터로 실제 모양을 그려 보여줌
export function StyleGallery({ layout, tel, thumb, onPick }: { layout: Layout; tel: Telemetry | null; thumb?: string; onPick: (id: string) => void }) {
  const cur = layout.style ?? THEMES[0].id;
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!thumb) return;
    const i = new Image();
    i.onload = () => setImg(i);
    i.src = thumb;
  }, [thumb]);
  const track = useMemo(() => (tel ? buildTrack(tel) : null), [tel]);
  // 기울기·속도가 보이는 순간을 골라 보여줌
  const sample = useMemo((): { p: TelemetryPoint; t: number } => {
    if (!tel?.t.length) return { p: { pitch: -6, roll: 14, heading: 312, speed: 9.5, vz: -0.8, relAlt: 24.6 } as TelemetryPoint, t: 0 };
    let best = tel.t[0], score = -1;
    for (let k = 0; k < tel.t.length; k += Math.max(1, Math.floor(tel.t.length / 200))) {
      const q = sampleAt(tel, tel.t[k]);
      if (!q) continue;
      const v = Math.abs(q.roll) + Math.abs(q.pitch) + q.speed;
      if (v > score) (score = v), (best = tel.t[k]);
    }
    return { p: sampleAt(tel, best)!, t: best };
  }, [tel]);
  const lang = getLang();
  return (
    <div class="style-grid" role="radiogroup" aria-label={t("lay.style")}>
      {THEMES.map((th) => (
        <button key={th.id} role="radio" aria-checked={cur === th.id} class={`style-card ${cur === th.id ? "on" : ""}`} onClick={() => onPick(th.id)}>
          <StyleThumb id={th.id} img={img} p={sample.p} t={sample.t} track={track} layout={layout} />
          <span>{lang === "en" ? th.en : th.ko}</span>
        </button>
      ))}
    </div>
  );
}

// 미리보기는 지금 위젯 구성 그대로, 위젯별 스타일만 빼고 이 테마로
function StyleThumb({ id, img, p, t, track, layout }: { id: string; img: HTMLImageElement | null; p: TelemetryPoint; t: number; track: ReturnType<typeof buildTrack> | null; layout: Layout }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const W = (c.width = 384), H = (c.height = 216);
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#20262f";
    ctx.fillRect(0, 0, W, H);
    if (img) ctx.drawImage(img, 0, 0, W, H);
    const widgets = widgetsOf(layout).map((w) => ({ ...w, style: undefined }));
    drawHud(ctx, W, H, p, { t, track, tiles: null, instruments: true, layout: { ...layout, widgets, style: id, osd: [] } });
  }, [id, img, p, track, layout.widgets, layout.style, layout.text, layout.attitude]);
  return <canvas ref={ref} aria-hidden="true" />;
}

export const widgetName = (k: WidgetKind) => (getLang() === "en" ? WIDGET_INFO[k].en : WIDGET_INFO[k].ko);

// 배치 템플릿: 위젯 구성·위치를 통째로 바꿈
function TemplatePicker({ onPick }: { onPick: (id: string) => void }) {
  const en = getLang() === "en";
  return (
    <div class="chip-row" role="group" aria-label={t("lay.template")}>
      {TEMPLATES.map((tp) => (
        <button key={tp.id} class="soft-btn sm" onClick={() => onPick(tp.id)}>
          <TemplateGlyph widgets={tp.widgets} />
          {en ? tp.en : tp.ko}
        </button>
      ))}
    </div>
  );
}
// 템플릿 모양을 작은 그림으로
function TemplateGlyph({ widgets }: { widgets: Omit<Widget, "id">[] }) {
  return (
    <svg class="tpl-glyph" viewBox="0 0 32 18" aria-hidden="true">
      <rect x="0.5" y="0.5" width="31" height="17" rx="2.5" />
      {widgets.map((w) =>
        WIDGET_INFO[w.kind].round ? (
          <circle cx={(w.x + w.w / 2) * 32} cy={(w.y + w.h / 2) * 18} r={Math.min(w.w * 32, w.h * 18) / 2} />
        ) : (
          <rect x={w.x * 32} y={w.y * 18} width={w.w * 32} height={Math.max(1, w.h * 18)} rx="0.6" />
        ),
      )}
    </svg>
  );
}

// 화면에 올린 위젯 목록: 고르기(화면과 연동) / 위젯별 스타일 / 빼기, 위에서 새 위젯 추가
function WidgetList({ ed, setEd }: { ed: EditState; setEd: SetEd }) {
  const ws = widgetsOf(ed.draft);
  const en = getLang() === "en";
  const [adding, setAdding] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const selId = ed.sel?.kind === "hud" ? ed.sel.id : null;
  // 화면에서 위젯을 고르면 목록에서도 보이게
  useEffect(() => {
    if (selId) list.current?.querySelector(`[data-id="${selId}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selId]);
  const patch = (id: string, p: Partial<Widget>) =>
    setEd((e) => ({ ...e, draft: { ...e.draft, widgets: widgetsOf(e.draft).map((w) => (w.id === id ? { ...w, ...p } : w)) } }));
  const remove = (id: string) => setEd((e) => ({ ...e, sel: null, draft: { ...e.draft, widgets: widgetsOf(e.draft).filter((w) => w.id !== id) } }));
  const add = (k: WidgetKind) =>
    setEd((e) => {
      const r = addWidget(e.draft, k);
      return { ...e, draft: r.layout, sel: { kind: "hud", id: r.id } };
    });
  const counts = ws.reduce<Record<string, number>>((a, w) => ((a[w.kind] = (a[w.kind] ?? 0) + 1), a), {});
  return (
    <Section
      title={<>{t("lay.widgets")} <span class="count">{ws.length}</span></>}
      extra={
        <button class={`soft-btn xs ${adding ? "active" : ""}`} aria-expanded={adding} onClick={(e) => { e.preventDefault(); setAdding(!adding); }}>
          <Plus size={13} /> {t("lay.addWidget")}
        </button>
      }
    >
      {adding && (
        <div class="add-grid">
          {WIDGET_KINDS.map((k) => (
            <button key={k} class="add-chip" onClick={() => { add(k); setAdding(false); }}>
              <span>{widgetName(k)}</span>
              {WIDGET_INFO[k].gps && <span class="tag">GPS</span>}
              {counts[k] ? <span class="have">✓</span> : null}
            </button>
          ))}
        </div>
      )}
      {!ws.length && <p class="note">{t("lay.noWidgets")}</p>}
      <ul class="widget-list" ref={list}>
        {ws.map((w) => {
          const on = selId === w.id;
          return (
            <li class={`widget-row ${on ? "on" : ""}`} key={w.id} data-id={w.id} onClick={() => setEd((e) => ({ ...e, sel: { kind: "hud", id: w.id } }))}>
              <span class={`wdot ${isRound(w) ? "round" : ""}`} aria-hidden="true" />
              <b>{widgetName(w.kind)}</b>
              <span class="spacer" />
              <select class="mini-select" value={w.style ?? ""} aria-label={t("lay.widgetStyle")} title={t("lay.widgetStyle")} onClick={(e) => e.stopPropagation()} onChange={(e) => patch(w.id, { style: (e.target as HTMLSelectElement).value || undefined })}>
                <option value="">{t("lay.followTheme")}</option>
                {THEMES.map((th) => <option value={th.id}>{en ? th.en : th.ko}</option>)}
              </select>
              <button class="icon-btn sm" aria-label={t("lay.removeWidget")} title={t("lay.removeWidget")} onClick={(e) => { e.stopPropagation(); remove(w.id); }}><Trash2 size={14} /></button>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

// 숫자 표시: 글꼴(모노/7-세그먼트/스타일 글꼴)·크기·색
const SWATCHES = [null, "#ffffff", "#ffd23f", "#5dff7a", "#4fd1ff", "#ff4fd8", "#ff5b4f"];
export function TextOptions({ text, onChange }: { text?: HudText; onChange: (t: HudText) => void }) {
  const cur = { num: "mono", scale: 1, color: null, segBg: false, ...text } as Required<HudText>;
  const set = (p: Partial<HudText>) => onChange({ ...cur, ...p });
  const opts: { k: Required<HudText>["num"]; label: string }[] = [
    { k: "mono", label: t("txt.mono") },
    { k: "seg7", label: t("txt.seg7") },
    { k: "theme", label: t("txt.theme") },
  ];
  return (
    <div class="text-opts">
      <div class="row">
        <span class="muted small">{t("txt.font")}</span>
        <span class="spacer" />
        <div class="seg-control neu-inset mini" role="radiogroup" aria-label={t("txt.font")}>
          {opts.map((o) => (
            <button role="radio" aria-checked={cur.num === o.k} class={cur.num === o.k ? "on" : ""} onClick={() => set({ num: o.k })}>{o.label}</button>
          ))}
        </div>
      </div>
      {cur.num === "seg7" && (
        <div class="row">
          <span class="muted small">{t("txt.segBg")}</span>
          <span class="spacer" />
          <div class="seg-control neu-inset mini" role="radiogroup" aria-label={t("txt.segBg")}>
            <button role="radio" aria-checked={!cur.segBg} class={!cur.segBg ? "on" : ""} onClick={() => set({ segBg: false })}>{t("txt.segBgOff")}</button>
            <button role="radio" aria-checked={!!cur.segBg} class={cur.segBg ? "on" : ""} onClick={() => set({ segBg: true })}>{t("txt.segBgOn")}</button>
          </div>
        </div>
      )}
      <label class="slider">
        <span>{t("txt.size")}</span>
        <input type="range" min={0.7} max={1.6} step={0.05} value={cur.scale} onInput={(e) => set({ scale: Number((e.target as HTMLInputElement).value) })} />
        <span class="num">{Math.round(cur.scale * 100)}%</span>
      </label>
      <div class="row">
        <span class="muted small">{t("txt.color")}</span>
        <span class="spacer" />
        <div class="swatches" role="radiogroup" aria-label={t("txt.color")}>
          {SWATCHES.map((c) => (
            <button role="radio" aria-checked={cur.color === c} class={`swatch ${cur.color === c ? "on" : ""} ${c ? "" : "auto"}`} style={c ? { background: c } : undefined} title={c ?? t("txt.auto")} aria-label={c ?? t("txt.auto")} onClick={() => set({ color: c })} />
          ))}
        </div>
      </div>
    </div>
  );
}
