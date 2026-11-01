import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  ArrowLeft, Check, ChevronDown, ChevronRight, Compass, CloudUpload, Eye, EyeOff, ExternalLink, FolderOpen, Gauge, Glasses,
  Link2, Maximize2, ScrollText, Merge, Minus, Pause, Play, Plus, RotateCcw, ShieldCheck, TriangleAlert, Unlink,
} from "lucide-preact";
import { useApp, type Job } from "../app.tsx";
import type { Flight } from "../library.ts";
import { flightTitle, proxyRef } from "../library.ts";
import { fmtDay, fmtDur, fmtSize, fmtTime, t } from "../i18n.ts";
import { sampleAt, type Telemetry } from "../telemetry.ts";
import { drawHud } from "../hud.ts";
import { buildTrack, TileSource } from "../map.ts";
import { fileReader, frameImage } from "../frames.ts";
import { parse } from "../mp4.ts";
import { OsdCompositor } from "../render.ts";
import type { Layout } from "../store.ts";
import { EditOverlay, HudPanel, OsdPanel, Section, useLayoutEditor, type EditState } from "./LayoutEditor.tsx";
import type { StaticMask } from "../osdkey.ts";
import { analyzeGoggles } from "../osdstat.ts";
import { confidenceLabel } from "../sync.ts";
import { joinLabel, StatusChip } from "./Flights.tsx";
import { Spinner } from "./Shell.tsx";

type Tab = "merge" | "hud" | "goggles" | "upload";
type Seg = { file: File; offset: number; duration: number; view?: "inset" | "full"; stat?: StaticMask };

// 비행 하나를 여는 작업 공간: 큰 플레이어 + 병합 타임라인 + 설정 패널
export function Project({ f }: { f: Flight }) {
  const app = useApp();
  const prefs = app.prefsOf(f.id);
  const job = app.job?.flightId === f.id ? app.job : null;
  const [tel, setTel] = useState<Telemetry | null | undefined>(undefined);
  const [srcs, setSrcs] = useState<{ files: { file: File; dur: number }[]; kind: "overlay" | "output" | "proxy" } | null>(null);
  const gog = app.gogglesOf(f);
  const [tab, setTab] = useState<Tab>(f.status === "pending" && f.clips.length > 1 ? "merge" : "hud");
  const [focus, setFocus] = useState<{ i: number; k: number } | null>(null);

  // 비행 데이터는 파일 목록이 다시 읽혀도(핸들이 바뀌어도) 같은 비행이면 다시 읽지 않음
  const [telErr, setTelErr] = useState("");
  useEffect(() => {
    let alive = true;
    setTel(undefined);
    setTelErr("");
    app.telemetryOf(f).then((x) => alive && setTel(x)).catch((e) => {
      if (!alive) return;
      setTel(null);
      setTelErr((e as Error).message ?? String(e));
    });
    return () => void (alive = false);
  }, [f.id, f.output?.name, f.clips.map((c) => c.name).join(), !!app.idx]);

  useEffect(() => {
    let alive = true;
    (async () => {
      let p = await app.previewFile(f);
      if (!p) return setSrcs(null);
      // 플레이어는 항상 원본 위에 HUD·OSD 를 실시간으로 겹쳐 그림 (구운 영상은 "완성 영상 보기"에서만)
      if (p.kind === "overlay" && f.output?.ref) p = { file: await f.output.ref.handle.getFile(), kind: "output" };
      // 병합 전에는 클립들의 미리보기 파일을 이어서 재생 = 병합 결과 미리보기
      if (p.kind === "proxy" && f.clips.length > 1 && app.idx) {
        const files: { file: File; dur: number }[] = [];
        for (const c of f.clips) {
          const ref = proxyRef(app.idx, c.stem);
          if (!ref) return alive && setSrcs({ files: [{ file: p.file, dur: f.clips[0].duration }], kind: p.kind });
          files.push({ file: await ref.handle.getFile(), dur: c.duration });
        }
        if (alive) setSrcs({ files, kind: p.kind });
      } else if (alive) setSrcs({ files: [{ file: p.file, dur: f.duration }], kind: p.kind });
    })().catch(() => alive && setSrcs(null));
    return () => void (alive = false);
  }, [f.id, f.status, f.overlay?.name, f.output?.ref?.handle, f.overlay?.ref?.handle]); // 파일 목록이 새로 스캔되면 다시 읽음

  // 고글 후보가 있으면 열자마자 자동으로 맞춘다 (비행당 한 번)
  const autoTried = useRef(false);
  useEffect(() => {
    if (!autoTried.current && gog.candidates.length && !app.job) {
      autoTried.current = true;
      app.syncGogglesFor(f, gog.candidates);
    }
  }, [gog.candidates.map((c) => c.name).join()]);

  // 고글 파일마다 화면 배율(축소/전체)과 고정 OSD 통계를 분석. 배율은 연결 정보에 저장(사용자가 바꾼 값은 유지)
  const [stats, setStats] = useState<Record<string, StaticMask>>({});
  const gogNames = gog.links.filter((x) => x.info).map((x) => x.link.file).join();
  useEffect(() => {
    let alive = true;
    for (const x of gog.links) {
      if (!x.info) continue;
      analyzeGoggles(x.info.file).then((a) => {
        if (!alive) return;
        setStats((m) => ({ ...m, [x.link.file]: a.stat }));
        if (!x.link.view) app.setGogglesView(f, x.link.file, a.view, false);
      }).catch(() => {});
    }
    return () => void (alive = false);
  }, [gogNames]);

  // Esc = 라이브러리로
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || app.showSettings || document.fullscreenElement) return;
      if ((e.target as HTMLElement)?.closest?.("input, textarea, select, .ebox")) return;
      if (le.ed?.sel) return le.setEd((x) => ({ ...x, sel: null })); // 위젯 선택 해제 먼저
      app.select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const hasTel = !!tel?.t.length;
  const telKnown = tel !== undefined;
  const gogSegs: Seg[] = gog.links.filter((x) => x.info).map((x) => {
    const view = x.link.view ?? app.layout.gogglesView ?? "inset";
    return { file: x.info!.file, offset: x.link.offset, duration: x.info!.duration, view, stat: stats[x.link.file] };
  });
  // HUD 탭 = 위젯 편집, 고글 탭 = OSD 영역 편집 (플레이어 위에서 바로, 자동 저장)
  const le = useLayoutEditor(app.layout, app.setLayout, !srcs ? null : tab === "hud" ? "hud" : tab === "goggles" && gogSegs.length ? "osd" : null);
  const ed = le.ed;
  const hudOn = prefs.instruments || prefs.map;
  const canOverlay = (hasTel && (prefs.instruments || prefs.map)) || (prefs.goggles && gogSegs.length > 0);
  const title = flightTitle(f, app.state, (n) => t("flight", { n }));
  const origSize = f.clips.reduce((a, c) => a + c.size, 0) || f.size;
  const verified = f.record?.verified;
  const verifiedOk = !!verified && verified.frames === verified.sourceFrames;

  const steps: { key: Tab; label: string; state: "todo" | "run" | "done" }[] = [
    { key: "merge", label: t("step.merge"), state: f.status === "done" ? "done" : job?.phase === "merge" ? "run" : "todo" },
    { key: "merge", label: t("step.verify"), state: verified ? "done" : job?.phase === "verify" ? "run" : "todo" },
    ...(gogSegs.length
      ? [{
          key: "goggles" as Tab, label: t("step.goggles"),
          state: (job && (job.phase === "goggles" || job.phase === "gmerge") ? "run" : gogSegs.length > 1 && app.gogglesMergeNeeded(f) ? "todo" : "done") as "todo" | "run" | "done",
        }]
      : []),
    { key: "hud", label: t("step.overlay"), state: f.overlay ? "done" : job && (job.phase === "render" || job.phase === "tiles") ? "run" : "todo" },
  ];

  return (
    <div class="project">
      <header class="proj-bar glass">
        <button class="ghost-btn back" onClick={() => app.select(null)} title="Esc">
          <ArrowLeft size={17} strokeWidth={2} /> {t("proj.back")}
        </button>
        <div class="proj-title">
          <input
            class="title-input"
            value={prefs.title ?? ""}
            placeholder={title}
            aria-label={t("insp.title")}
            onChange={(e) => app.setPrefs(f.id, { title: (e.target as HTMLInputElement).value.trim() || undefined })}
          />
          <p class="sub num">
            {fmtDay(f.start)} · {fmtTime(f.start)} – {fmtTime(f.end)} · {t("flight.clips", { n: f.clips.length })} · {fmtDur(f.duration)} · {fmtSize(origSize)}
          </p>
        </div>
        <ol class="stepper" aria-label="pipeline">
          {steps.map((s, i) => (
            <li class={s.state} key={s.label}>
              {i > 0 && <span class="step-line" aria-hidden="true" />}
              <button onClick={() => setTab(s.key)}>
                <span class="step-dot">{s.state === "run" ? <Spinner size={12} /> : s.state === "done" ? <Check size={12} strokeWidth={3} /> : i + 1}</span>
                {s.label}
              </button>
            </li>
          ))}
        </ol>
        <RunBar f={f} job={job} canOverlay={!!canOverlay} />
      </header>

      <div class="proj-body">
        <section class="stage-col" aria-label={title}>
          {srcs ? (
            <Player
              key={srcs.files.map((s) => s.file.name).join()}
              f={f}
              srcs={srcs.files}
              burned={srcs.kind === "overlay"}
              tel={tel ?? null}
              prefs={prefs}
              mapsKey={app.config.mapsKey}
              goggles={(prefs.goggles || ed?.mode === "osd") && gogSegs.length ? gogSegs : null}
              layout={ed?.draft ?? app.layout}
              edit={ed}
              overlay={ed && <EditOverlay ed={ed} setEd={le.setEd} />}
              gogSegs={gogSegs}
              gogLinks={gog.links}
              job={job}
              verifiedOk={verifiedOk}
              onSeam={(i) => { setTab("merge"); setFocus({ i, k: Date.now() }); }}
            />
          ) : (
            <div class="player-empty"><div class="thumb-ph" /></div>
          )}
        </section>

        <aside class="panel glass">
          <div class="seg-control neu-inset tabs" role="tablist">
            <button role="tab" aria-selected={tab === "merge"} class={tab === "merge" ? "on" : ""} onClick={() => setTab("merge")}>
              <Merge size={15} strokeWidth={1.9} /> {t("step.merge")}
            </button>
            <button role="tab" aria-selected={tab === "hud"} class={tab === "hud" ? "on" : ""} onClick={() => setTab("hud")}>
              <Gauge size={15} strokeWidth={1.9} /> HUD
            </button>
            <button role="tab" aria-selected={tab === "goggles"} class={tab === "goggles" ? "on" : ""} onClick={() => setTab("goggles")}>
              <Glasses size={15} strokeWidth={1.9} /> {t("step.goggles")}
              {gog.candidates.length > 0 && !gog.links.length && <span class="tab-dot" aria-hidden="true" />}
            </button>
            {app.config.youtube && f.status === "done" && (
              <button role="tab" aria-selected={tab === "upload"} class={tab === "upload" ? "on" : ""} onClick={() => setTab("upload")}>
                <CloudUpload size={15} strokeWidth={1.9} /> YouTube
              </button>
            )}
          </div>

          <div class="panel-scroll" role="tabpanel" key={tab}>
            {tab === "merge" && (
              <>
                <LogSummary f={f} />
                {verified ? (
                  <p class={`verify ${verifiedOk ? "ok" : "bad"}`}>
                    {verifiedOk ? <Check size={15} strokeWidth={2.5} /> : <TriangleAlert size={15} />}
                    <span class="num">{t("verify.ok", { a: verified.frames.toLocaleString(), b: verified.sourceFrames.toLocaleString() })}</span>
                    <span class="muted num">{t("verify.duration", { d: fmtDur(verified.duration) })}</span>
                  </p>
                ) : (
                  <p class="note">{f.clips.length > 1 ? t("verify.pending") : t("merge.single")}</p>
                )}
                {f.status === "done" && f.clips.length > 1 && f.size !== origSize && (
                  <details class="size-note">
                    <summary class="num"><ChevronRight size={13} strokeWidth={2} /> {t("insp.sizeMerged", { a: fmtSize(f.size), b: fmtSize(origSize) })}</summary>
                    <p>{t("insp.sizeWhy")}</p>
                  </details>
                )}
                <ClipOrder f={f} focus={focus} />
                <p class="note"><ShieldCheck size={14} strokeWidth={2} /> {t("merge.lossless")}</p>
                {f.output && f.status === "done" && <p class="note"><FolderOpen size={14} strokeWidth={2} /> {t("out.location", { path: `2_ready/${f.output.name}` })}</p>}
              </>
            )}

            {tab === "hud" && (
              <>
                <Toggle
                  on={hudOn && (hasTel || !telKnown)}
                  disabled={telKnown && !hasTel}
                  onChange={(v) => app.setPrefs(f.id, { instruments: v, map: v })}
                  icon={<Gauge size={16} strokeWidth={1.75} />}
                  label={t("ov.hudThis")}
                  hint={hasTel && !app.config.mapsKey ? t("ov.mapNoKey") : t("ov.hudAll")}
                />
                {tel === undefined ? <p class="note"><Spinner size={13} /></p> : !hasTel && (
                  <p class="note warn"><TriangleAlert size={14} /> <span>{t("ov.noTelemetry")}{telErr && <><br /><small class="mono">{telErr}</small></>}</span></p>
                )}
                {ed?.mode === "hud" ? <HudPanel le={le} tel={tel ?? null} thumb={app.thumb(f.clips[0].stem)} /> : <p class="note"><Spinner size={13} /></p>}
                {f.overlay && <p class="note"><FolderOpen size={14} strokeWidth={2} /> {t("out.location", { path: `2_ready/${f.overlay.name}` })}</p>}
              </>
            )}

            {tab === "goggles" && (
              <>
                <Toggle on={prefs.goggles && gogSegs.length > 0} disabled={!gogSegs.length} onChange={(v) => app.setPrefs(f.id, { goggles: v })} icon={<Glasses size={16} strokeWidth={1.75} />} label={t("ov.gogThis")} hint={t("ov.gogHint")} />
                {ed?.mode === "osd" && <OsdPanel le={le} />}
                <Section title={t("gog.linkTitle")} open={!gogSegs.length || gog.candidates.length > 0}>
                  <GogglesPanel f={f} job={job} />
                </Section>
                <GogglesMergeRow f={f} job={job} />
              </>
            )}

            {tab === "upload" && <YoutubeRow f={f} />}
          </div>
        </aside>
      </div>

    </div>
  );
}

const PHASE_LABEL: Record<string, Parameters<typeof t>[0]> = {
  merge: "run.merging", verify: "run.verifying", gmerge: "run.gmerging", tiles: "run.tiles", render: "run.rendering", goggles: "gog.syncing", upload: "up.one", copy: "gog.add",
};

function RunBar({ f, job, canOverlay }: { f: Flight; job: Job | null; canOverlay: boolean }) {
  const app = useApp();
  if (job) {
    const pct = Math.min(100, (job.done / Math.max(1, job.total)) * 100);
    const elapsed = (Date.now() - job.started) / 1000;
    const eta = pct > 3 && pct < 100 ? (elapsed / pct) * (100 - pct) : 0;
    return (
      <div class="runbar">
        <div class="run-progress">
          <div class="run-text">
            <b>{t(PHASE_LABEL[job.phase])}</b>
            <span class="num">{Math.round(pct)}%{eta > 2 ? ` · ${t("run.eta", { t: fmtDur(eta) })}` : ""}</span>
          </div>
          <div class="bar neu-inset"><div style={{ width: `${pct}%` }} /></div>
        </div>
        <button class="soft-btn" onClick={app.cancel}>{t("run.cancel")}</button>
      </div>
    );
  }
  const busy = !!app.job;
  if (f.status === "pending") {
    return (
      <div class="runbar">
        {canOverlay && (
          <button class="soft-btn" disabled={busy} onClick={() => app.run(f, { merge: true, overlay: false })}>
            {f.clips.length > 1 ? t("run.merge") : t("run.prepare")}
          </button>
        )}
        <button class="clay-btn" disabled={busy} onClick={() => app.run(f, { merge: true, overlay: canOverlay })}>
          {canOverlay ? <Gauge size={17} strokeWidth={2} /> : <Merge size={17} strokeWidth={2} />}
          {canOverlay ? t("run.mergeAndOverlay") : f.clips.length > 1 ? t("run.merge") : t("run.prepare")}
        </button>
      </div>
    );
  }
  // 완성(구운) 영상을 전체 화면으로
  const watch = async () => {
    if (!f.overlay?.ref) return;
    const url = URL.createObjectURL(await f.overlay.ref.handle.getFile());
    const v = Object.assign(document.createElement("video"), { src: url, controls: true, playsInline: true, className: "watch-video" });
    document.body.append(v);
    const done = () => {
      if (document.fullscreenElement) return;
      v.remove();
      URL.revokeObjectURL(url);
      document.removeEventListener("fullscreenchange", done);
    };
    try {
      await v.requestFullscreen();
      document.addEventListener("fullscreenchange", done);
    } catch {
      v.remove();
      URL.revokeObjectURL(url);
      return;
    }
    v.play().catch(() => {});
  };
  if (f.overlay) {
    return (
      <div class="runbar">
        <button class="soft-btn" disabled={busy || !canOverlay || !f.output?.ref} title={t("ov.replace")} onClick={() => app.run(f, { merge: false, overlay: true })}>
          <RotateCcw size={15} /> {t("run.overlayAgain")}
        </button>
        <button class="clay-btn" onClick={watch}>
          <Maximize2 size={17} strokeWidth={2} /> {t("run.watch")}
        </button>
      </div>
    );
  }
  return (
    <div class="runbar">
      <button class="clay-btn" disabled={busy || !canOverlay || !f.output?.ref} onClick={() => app.run(f, { merge: false, overlay: true })}>
        <Gauge size={17} strokeWidth={2} /> {t("run.overlay")}
      </button>
    </div>
  );
}

// 플레이어: 여러 파일을 하나의 비행 시간축으로 이어 재생하고, 그 위에 HUD·고글 OSD 를 실제 합성과 같은 방식으로 그림
function Player({ f, srcs, burned, tel, prefs, mapsKey, goggles, layout, edit, overlay, gogSegs, gogLinks, job, verifiedOk, onSeam }: {
  f: Flight; srcs: { file: File; dur: number }[]; burned: boolean; tel: Telemetry | null; prefs: ReturnType<ReturnType<typeof useApp>["prefsOf"]>; mapsKey: string;
  goggles: Seg[] | null; layout: Layout; edit: EditState | null; overlay: preact.ComponentChildren; gogSegs: Seg[]; gogLinks: ReturnType<ReturnType<typeof useApp>["gogglesOf"]>["links"];
  job: Job | null; verifiedOk: boolean; onSeam: (i: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [on, setOn] = useState(true);
  const track = useMemo(() => (tel ? buildTrack(tel) : null), [tel]);
  const tiles = useMemo(() => (mapsKey && track?.t.length ? new TileSource(mapsKey) : null), [mapsKey, track]);
  const gogFrame = useGogglesVideo(goggles);
  const osd = useMemo(() => new OsdCompositor(), []);
  const urls = useMemo(() => srcs.map((s) => URL.createObjectURL(s.file)), [srcs]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  const offs = useMemo(() => srcs.reduce<number[]>((a, s, i) => (a.push(i ? a[i - 1] + srcs[i - 1].dur : 0), a), []), [srcs]);
  const total = srcs.length > 1 ? offs[offs.length - 1] + srcs[srcs.length - 1].dur : 0;
  const seg = useRef(0);
  const pending = useRef<{ t: number; play: boolean } | null>(null);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(total);
  const [playing, setPlaying] = useState(false);
  const now = () => offs[seg.current] + (videoRef.current?.currentTime ?? 0);

  const load = (i: number, t: number, play: boolean) => {
    const v = videoRef.current;
    if (!v) return;
    seg.current = i;
    if (v.src !== urls[i]) {
      pending.current = { t, play };
      v.src = urls[i];
    } else {
      v.currentTime = t;
      if (play) v.play().catch(() => {});
    }
  };
  const seek = (g: number) => {
    const v = videoRef.current;
    if (!v) return;
    let i = 0;
    while (i < offs.length - 1 && g >= offs[i + 1]) i++;
    load(i, Math.max(0, g - offs[i]), !v.paused);
    setTime(g);
  };
  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };

  useEffect(() => {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c) return;
    let raf = 0;
    let last = -1;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const t = now();
      if (Math.abs(t - last) > 1 / 30) setTime((last = t));
      const r = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.round(r.width * dpr)) c.width = Math.round(r.width * dpr);
      if (c.height !== Math.round(r.height * dpr)) c.height = Math.round(r.height * dpr);
      const ctx = c.getContext("2d")!;
      ctx.clearRect(0, 0, c.width, c.height);
      if (!edit && (!on || burned)) return;
      const W = c.width, H = c.height;
      const g = gogFrame(t, !v.paused);
      // 고글 OSD 편집: 고글 화면 전체를 반투명하게 겹쳐 어디를 잘라낼지 보이게
      const osdEdit = edit?.mode === "osd";
      if (g && osdEdit && edit.ghost > 0) {
        ctx.globalAlpha = edit.ghost;
        ctx.drawImage(g.el, 0, 0, W, H);
        ctx.globalAlpha = 1;
      }
      if (g) osd.draw(ctx, g.el, layout.osd, W, H, g.seg.view, g.seg.stat);
      const p = tel ? sampleAt(tel, t) : null;
      ctx.globalAlpha = osdEdit ? 0.4 : 1;
      if (p && (prefs.instruments || prefs.map || edit)) drawHud(ctx, W, H, p, { t, track, tiles, instruments: prefs.instruments || !!edit, map: prefs.map || !!edit, layout });
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [tel, on, burned, track, tiles, goggles, prefs.instruments, prefs.map, layout, offs, edit?.mode, edit?.ghost, !!edit]);

  // 키보드: 스페이스 재생, ←/→ 5초
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea, button, [role=dialog], .ebox")) return;
      if (e.key === " ") (e.preventDefault(), toggle());
      if (e.key === "ArrowLeft") seek(Math.max(0, now() - 5));
      if (e.key === "ArrowRight") seek(Math.min(dur, now() + 5));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dur, offs]);

  return (
    <div class="player">
      <div class={`player-frame ${edit ? "editing" : ""}`} onClick={edit ? undefined : toggle}>
        <div class="player-box">
          <video
            src={urls[0]}
            ref={videoRef}
            playsInline
            muted
            preload="metadata"
            onLoadedMetadata={(e) => {
              const v = e.target as HTMLVideoElement;
              if (srcs.length === 1) setDur(v.duration);
              const p = pending.current;
              pending.current = null;
              if (p) {
                v.currentTime = p.t;
                if (p.play) v.play().catch(() => {});
              }
            }}
            onEnded={() => (seg.current < srcs.length - 1 ? load(seg.current + 1, 0, true) : setPlaying(false))}
            onPlay={() => setPlaying(true)}
            onPause={(e) => !pending.current && !((e.target as HTMLVideoElement).ended && seg.current < srcs.length - 1) && setPlaying(false)}
          />
          <canvas ref={canvasRef} aria-hidden="true" />
          {overlay}
          {!playing && !edit && <span class="play-badge" aria-hidden="true"><Play size={26} fill="currentColor" /></span>}
        </div>
      </div>
      <div class="player-controls">
        <button class="icon-btn neu" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
          {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
        </button>
        <span class="num small time">{fmtDur(time)} <span class="muted">/ {fmtDur(dur)}</span></span>
        <span class="spacer" />
        {srcs.length > 1 && <span class="muted small">{t("proj.mergePreview")}</span>}
        {!burned && !edit && (tel || goggles) && (
          <label class="check" title={t("ov.preview")}>
            <input type="checkbox" checked={on} onChange={(e) => setOn((e.target as HTMLInputElement).checked)} />
            <Compass size={14} strokeWidth={1.75} /> HUD
          </label>
        )}
      </div>
      <Timeline f={f} time={time} dur={dur || f.duration} seek={seek} gogSegs={gogSegs} gogLinks={gogLinks} job={job} verifiedOk={verifiedOk} onSeam={onSeam} />
    </div>
  );
}

// 타임라인: 클립(길이 비례, 썸네일) + 이음매 + 고글 구간 + 재생 위치. 병합 중이면 진행만큼 차오름
function Timeline({ f, time, dur, seek, gogSegs, gogLinks, job, verifiedOk, onSeam }: {
  f: Flight; time: number; dur: number; seek: (t: number) => void; gogSegs: Seg[]; gogLinks: ReturnType<ReturnType<typeof useApp>["gogglesOf"]>["links"];
  job: Job | null; verifiedOk: boolean; onSeam: (i: number) => void;
}) {
  const app = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const total = f.duration || dur || 1;
  const fill = job && (job.phase === "merge" || job.phase === "verify") ? (job.phase === "verify" ? 1 : job.done / Math.max(1, job.total)) : f.status === "done" ? 1 : 0;
  const scrub = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    seek(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * dur);
  };
  const down = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest(".tl-seam")) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    scrub(e);
  };
  let acc = 0;
  return (
    <div class={`timeline neu-inset ${f.status}`}>
      <div class="tl-labels" aria-hidden="true">
        <span><Merge size={13} strokeWidth={2} /> {t("tl.video")}</span>
        <span><Glasses size={13} strokeWidth={2} /> {t("tl.goggles")}</span>
      </div>
      <div class="tl-tracks" ref={ref} onPointerDown={down} onPointerMove={(e) => e.buttons && (e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId) && scrub(e)}>
        <div class="tl-row clips">
          {f.clips.map((c, i) => {
            const start = acc / total;
            acc += c.duration;
            const segFill = Math.min(1, Math.max(0, (fill - start) / (c.duration / total)));
            const th = app.thumb(c.stem);
            return (
              <>
                {i > 0 && (
                  <button
                    class={`tl-seam ${verifiedOk ? "verified" : f.joins[i - 1]?.reason ?? "auto"}`}
                    style={{ left: `${start * 100}%` }}
                    title={`${joinLabel(f.joins[i - 1])} · ${t("merge.seam")}`}
                    aria-label={`${joinLabel(f.joins[i - 1])} · ${t("merge.seam")}`}
                    onClick={() => onSeam(i)}
                  >
                    {verifiedOk ? <Check size={12} strokeWidth={3} /> : <Link2 size={12} strokeWidth={2.2} />}
                  </button>
                )}
                <div class="tl-clip" style={{ left: `${start * 100}%`, width: `${(c.duration / total) * 100}%`, backgroundImage: th ? `url(${th})` : undefined }}>
                  <span class="tl-fill" style={{ transform: `scaleX(${segFill})` }} />
                  <span class="tl-clip-label num">{fmtTime(c.start)} · {fmtDur(c.duration)}</span>
                </div>
              </>
            );
          })}
        </div>
        <div class="tl-row goggles">
          {gogSegs.length ? (
            gogSegs.map((g, i) => {
              const conf = confidenceLabel(gogLinks.find((l) => l.info?.file === g.file)?.link.score ?? 0);
              const l = Math.max(0, g.offset / total), r = Math.min(1, (g.offset + g.duration) / total);
              return r > l ? (
                <div class={`tl-gog ${conf}`} key={i} style={{ left: `${l * 100}%`, width: `${(r - l) * 100}%` }} title={g.file.name}>
                  <span class="mono">{g.file.name}</span>
                </div>
              ) : null;
            })
          ) : (
            <span class="tl-empty">{t("tl.noGoggles")}</span>
          )}
        </div>
        <span class="tl-head" style={{ left: `${Math.min(1, time / dur) * 100}%` }} aria-hidden="true" />
      </div>
    </div>
  );
}

function Toggle({ on, disabled, onChange, icon, label, hint }: { on: boolean; disabled?: boolean; onChange: (v: boolean) => void; icon: preact.ComponentChild; label: string; hint?: string }) {
  return (
    <label class={`toggle ${disabled ? "disabled" : ""}`}>
      {icon}
      <span class="toggle-text">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <input type="checkbox" role="switch" checked={on} disabled={disabled} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
      <span class="switch neu-inset" aria-hidden="true"><span class="knob" /></span>
    </label>
  );
}

function ClipOrder({ f, focus }: { f: Flight; focus: { i: number; k: number } | null }) {
  const app = useApp();
  const pending = f.status === "pending";
  return (
    <ol class="clip-order">
      {f.clips.map((c, i) => (
        <>
          {i > 0 && <SeamRow f={f} i={i} pending={pending} focus={focus?.i === i ? focus.k : 0} />}
          <li class="clip-row" key={c.stem}>
            <div class="clip-thumb">{app.thumb(c.stem) ? <img src={app.thumb(c.stem)} alt="" /> : <div class="thumb-ph" />}</div>
            <div class="clip-meta">
              <b class="num">{fmtTime(c.start)}</b>
              <span class="num">{fmtDur(c.duration)} · {fmtSize(c.size)}</span>
              <span class="mono small">{c.name}</span>
            </div>
            {pending && (
              <button class="icon-btn" title={t("merge.exclude")} aria-label={t("merge.exclude")} onClick={() => app.setOverride(c.name, "excluded", true)}>
                <EyeOff size={15} strokeWidth={1.75} />
              </button>
            )}
          </li>
        </>
      ))}
    </ol>
  );
}

function SeamRow({ f, i, pending, focus }: { f: Flight; i: number; pending: boolean; focus: number }) {
  const app = useApp();
  const j = f.joins[i - 1];
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLLIElement>(null);
  // 타임라인에서 이음매를 누르면 여기서 펼쳐 보여줌
  useEffect(() => {
    if (!focus) return;
    setOpen(true);
    rowRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focus]);
  const [imgs, setImgs] = useState<[string, string] | null>(null);
  useEffect(() => {
    if (open && !imgs) app.seam(f.clips[i - 1], f.clips[i]).then(setImgs).catch(() => {});
  }, [open]);
  const manual = app.state.overrides[f.clips[i].name]?.mergePrev !== undefined;
  return (
    <li class={`seam-row ${j.reason} ${focus ? "focus" : ""}`} ref={rowRef}>
      <button class="seam-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Link2 size={14} strokeWidth={2.2} />
        <span>{joinLabel(j)}</span>
        {j.gap !== null && <span class="muted num">{t("join.gap", { s: Math.abs(j.gap).toFixed(1) })}</span>}
        <span class="spacer" />
        <span class="link">{t("merge.seam")}</span>
        <ChevronDown size={14} class={open ? "rot" : ""} />
      </button>
      {open && (
        <div class="seam-view">
          <div class="seam-frames">
            {imgs ? <><img src={imgs[0]} alt="" /><img src={imgs[1]} alt="" /></> : <><div class="thumb-ph" /><div class="thumb-ph" /></>}
          </div>
          <p class="note">{t("merge.seamHint")}</p>
          {pending && (
            <div class="row">
              <button class="soft-btn sm" onClick={() => app.setOverride(f.clips[i].name, "mergePrev", false)}>
                <Unlink size={14} /> {t("join.split")}
              </button>
              {manual && (
                <button class="soft-btn sm" onClick={() => app.setOverride(f.clips[i].name, "mergePrev", undefined)}>
                  <RotateCcw size={14} /> {t("merge.reset")}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function GogglesPanel({ f, job }: { f: Flight; job: Job | null }) {
  const app = useApp();
  const { links, candidates } = app.gogglesOf(f);
  const [compare, setCompare] = useState<{ file: string; imgs: [string, string] | null } | null>(null);

  useEffect(() => {
    if (!compare || compare.imgs || !app.idx) return;
    const l = links.find((x) => x.link.file === compare.file);
    if (!l?.info) return;
    let alive = true;
    (async () => {
      // 이 고글 파일이 덮는 비행 구간의 가운데
      const tFlight = Math.min(f.duration - 1, Math.max(1, l.link.offset + l.info!.duration / 2));
      let base = 0;
      let clip = f.clips[0];
      for (const c of f.clips) {
        if (tFlight < base + c.duration) { clip = c; break; }
        base += c.duration;
      }
      const ref = proxyRef(app.idx!, clip.stem);
      if (!ref) return;
      const a = await frameImage(await ref.handle.getFile(), tFlight - base, 420);
      const b = await frameImage(l.info!.file, tFlight - l.link.offset, 420);
      if (alive) setCompare({ file: compare.file, imgs: [a, b] });
    })().catch(() => {});
    return () => void (alive = false);
  }, [compare?.file, compare?.imgs, links.map((x) => x.link.offset).join()]);

  if (job?.phase === "goggles") {
    return (
      <div class="goggles-box neu-inset">
        <Spinner /> <span>{t("gog.syncing")}</span>
        <div class="bar"><div style={{ width: `${((job.done + 0.5) / job.total) * 100}%` }} /></div>
      </div>
    );
  }
  return (
    <div class="goggles-stack">
      {links.map(({ link, info }) => {
        const conf = confidenceLabel(link.score);
        const frame = 1 / 60;
        const open = compare?.file === link.file;
        return (
          <div class="goggles-linked" key={link.file}>
            <div class="g-line">
              <Glasses size={16} strokeWidth={1.75} />
              <span class="mono small">{link.file}</span>
              {!info ? <span class="chip warn">{t("gog.missing")}</span> : <span class={`chip ${conf === "high" ? "done" : conf === "medium" ? "pending" : "warn"}`}>{t(`gog.confidence.${conf}` as "gog.confidence.high")}</span>}
            </div>
            <p class="note num">{t("gog.offset", { s: Math.abs(link.offset).toFixed(2), dir: link.offset >= 0 ? t("gog.later") : t("gog.earlier") })}</p>
            <div class="row">
              <span class="muted small">{t("gv.title")}</span>
              {link.view && !link.viewManual && <span class="chip pending">{t("gv.detected")}</span>}
              <span class="spacer" />
              <div class="seg-control neu-inset mini" role="radiogroup" aria-label={t("gv.title")}>
                <button role="radio" aria-checked={(link.view ?? "inset") === "inset"} class={(link.view ?? "inset") === "inset" ? "on" : ""} onClick={() => app.setGogglesView(f, link.file, "inset", true)}>{t("gv.inset")}</button>
                <button role="radio" aria-checked={link.view === "full"} class={link.view === "full" ? "on" : ""} onClick={() => app.setGogglesView(f, link.file, "full", true)}>{t("gv.full")}</button>
              </div>
            </div>
            {link.view === "full" && <p class="note warn small">{t("gv.fullHint")}</p>}
            <div class="row">
              <span class="muted small">{t("gog.nudge")}</span>
              <button class="icon-btn neu" aria-label="-1 frame" onClick={() => { app.nudgeGoggles(f, link.file, -frame); setCompare(open ? { file: link.file, imgs: null } : compare); }}><Minus size={14} /></button>
              <button class="icon-btn neu" aria-label="+1 frame" onClick={() => { app.nudgeGoggles(f, link.file, frame); setCompare(open ? { file: link.file, imgs: null } : compare); }}><Plus size={14} /></button>
              <span class="spacer" />
              <button class="soft-btn sm" onClick={() => setCompare(open ? null : { file: link.file, imgs: null })} disabled={!info}>{open ? <EyeOff size={14} /> : <Eye size={14} />} {t("gog.compare")}</button>
            </div>
            {open && (
              <div class="seam-frames labeled">
                <figure>{compare?.imgs ? <img src={compare.imgs[0]} alt="" /> : <div class="thumb-ph" />}<figcaption>{t("gog.flightFrame")}</figcaption></figure>
                <figure>{compare?.imgs ? <img src={compare.imgs[1]} alt="" /> : <div class="thumb-ph" />}<figcaption>{t("gog.gogglesFrame")}</figcaption></figure>
              </div>
            )}
          </div>
        );
      })}
      {(candidates.length > 0 || !links.length) && (
        <div class="goggles-box neu-inset">
          <Glasses size={18} strokeWidth={1.6} />
          {candidates.length ? (
            <>
              <span>{t("gog.candidate", { name: candidates.map((c) => c.name).join(", ") })}</span>
              <button class="soft-btn sm" onClick={() => app.syncGogglesFor(f, candidates)} disabled={!!app.job}>{t("gog.sync")}</button>
            </>
          ) : (
            <>
              <span><b>{t("gog.none")}</b><br /><small>{app.dirs?.gogglesExt ? t("gog.noneInFolder", { name: app.dirs.gogglesExt.name }) : t("gog.noneHint")}</small></span>
              <div class="gog-add">
                {!app.dirs?.gogglesExt && <button class="soft-btn sm" onClick={app.linkGogglesFolder} disabled={!!app.job}><FolderOpen size={14} /> {t("gfolder.pick")}</button>}
                <button class="text-btn" onClick={() => app.addGoggles("files")} disabled={!!app.job}>{t("gog.fromFiles")}</button>
              </div>
            </>
          )}
        </div>
      )}
      {links.length > 0 && <button class="text-btn" onClick={() => app.unlinkGoggles(f)}><Unlink size={14} /> {t("gog.unlink")}</button>}
    </div>
  );
}

// 비행기록 요약: 영상과 시간이 겹치는 기록 (DJI 키 없이 읽히는 부분만)
function LogSummary({ f }: { f: Flight }) {
  const app = useApp();
  const l = app.logOf(f);
  if (!l) {
    if (!app.idx?.logs.length && !app.dirs?.logsExt)
      return (
        <section class="logsum neu-inset empty">
          <ScrollText size={16} strokeWidth={1.75} />
          <span class="grow small">{t("flog.noneHint")}</span>
          <button class="soft-btn sm" onClick={app.linkLogsFolder} disabled={!!app.job}><FolderOpen size={14} /> {t("flog.pick")}</button>
        </section>
      );
    return <p class="note"><ScrollText size={14} strokeWidth={2} /> {t("flog.noMatch")}</p>;
  }
  const end = l.start + l.duration * 1000;
  const kmh = (v: number) => `${Math.round(v * 3.6)} km/h`;
  const into = (f.start - l.start) / 1000;
  return (
    <section class="logsum neu-inset">
      <h4 class="panel-h"><ScrollText size={15} strokeWidth={1.9} /> {t("flog.title")}</h4>
      <p class="num small">{t("flog.span", { a: fmtTime(l.start), b: fmtTime(end), d: fmtDur(l.duration) })}</p>
      <dl class="logstats num">
        <div><dt>{t("flog.dist")}</dt><dd>{l.distance >= 1000 ? `${(l.distance / 1000).toFixed(2)} km` : `${Math.round(l.distance)} m`}</dd></div>
        <div><dt>{t("flog.maxH")}</dt><dd>{Math.round(l.maxHeight)} m</dd></div>
        <div><dt>{t("flog.maxV")}</dt><dd>{kmh(l.maxSpeed)}</dd></div>
        <div><dt>{t("flog.maxVz")}</dt><dd>{l.maxVSpeed.toFixed(1)} m/s</dd></div>
        {l.videoTime >= 1 && <div><dt>{t("flog.video")}</dt><dd>{fmtDur(l.videoTime)}</dd></div>}
        <div><dt>{t("flog.aircraft")}</dt><dd>{l.aircraft}{l.aircraftSn ? ` ·${l.aircraftSn}` : ""}</dd></div>
      </dl>
      <LogBar l={l} f={f} />
      {into >= 0 && <p class="note small">{t("flog.cover", { s: fmtDur(into), e: fmtDur(f.duration) })}</p>}
      <p class="mono small muted" title={l.name}>{l.name}</p>
      <p class="note small">{t("flog.locked")}</p>
    </section>
  );
}

// 비행 전체(기록) 막대 위에 영상이 찍힌 구간 표시
function LogBar({ l, f }: { l: { start: number; duration: number }; f: Flight }) {
  const total = l.duration * 1000;
  const a = Math.max(0, (f.start - l.start) / total);
  const b = Math.min(1, (f.end - l.start) / total);
  return (
    <div class="logbar" aria-hidden="true">
      <span style={{ left: `${a * 100}%`, width: `${Math.max(0.5, (b - a) * 100)}%` }} />
    </div>
  );
}

function YoutubeRow({ f }: { f: Flight }) {
  const app = useApp();
  return (
    <section class="step yt">
      <h4><span class="step-icon"><CloudUpload size={16} strokeWidth={2} /></span>YouTube</h4>
      <div class="row">
        {f.youtubeId ? (
          <a class="chip done" href={`https://youtu.be/${f.youtubeId}`} target="_blank" rel="noreferrer">{t("up.original")} <ExternalLink size={12} strokeWidth={2} /></a>
        ) : (
          <button class="soft-btn sm" disabled={!!app.job} onClick={() => app.ytUpload([{ flight: f, overlay: false }])}>{t("up.original")} {t("up.one")}</button>
        )}
        {f.overlay &&
          (f.overlayYoutubeId ? (
            <a class="chip done" href={`https://youtu.be/${f.overlayYoutubeId}`} target="_blank" rel="noreferrer">{t("up.overlay")} <ExternalLink size={12} strokeWidth={2} /></a>
          ) : (
            <button class="soft-btn sm" disabled={!!app.job} onClick={() => app.ytUpload([{ flight: f, overlay: true }])}>{t("up.overlay")} {t("up.one")}</button>
          ))}
      </div>
    </section>
  );
}

// 미리보기: 영상 위에 HUD·고글 OSD 를 실제 합성과 같은 방식으로 겹쳐 그림
function useGogglesVideo(segs: Seg[] | null) {
  // 지금 시각을 덮는 고글 파일 하나만 <video> 로 열어 둔다
  const ref = useRef<HTMLVideoElement | null>(null);
  const cur = useRef<{ i: number; url: string } | null>(null);
  const durs = useRef<number[]>([]);
  useEffect(() => {
    if (!segs?.length) return;
    let alive = true;
    Promise.all(segs.map((s) => parse(fileReader(s.file)).then((tr) => tr.duration).catch(() => Infinity))).then((d) => alive && (durs.current = d));
    return () => {
      alive = false;
      if (cur.current) URL.revokeObjectURL(cur.current.url);
      cur.current = null;
    };
  }, [segs?.map((s) => s.file.name).join()]);
  const frameFor = (t: number, playing: boolean): { el: HTMLVideoElement; seg: Seg } | null => {
    if (!segs?.length) return null;
    const v = (ref.current ??= Object.assign(document.createElement("video"), { muted: true, playsInline: true, preload: "auto" }));
    const i = segs.findIndex((s, k) => t - s.offset >= 0 && t - s.offset <= (durs.current[k] ?? Infinity));
    if (i < 0) return null;
    if (cur.current?.i !== i) {
      if (cur.current) URL.revokeObjectURL(cur.current.url);
      cur.current = { i, url: URL.createObjectURL(segs[i].file) };
      v.src = cur.current.url;
    }
    const want = t - segs[i].offset;
    if (v.readyState >= 1 && Math.abs(v.currentTime - want) > 0.25) v.currentTime = want;
    if (playing && v.paused) v.play().catch(() => {});
    if (!playing && !v.paused) v.pause();
    return v.readyState >= 2 ? { el: v, seg: segs[i] } : null;
  };
  return frameFor;
}


// 고글 녹화 병합: 드론 병합과 같은 방식(무손실 이어붙임 + 프레임 수 검증)
function GogglesMergeRow({ f, job }: { f: Flight; job: Job | null }) {
  const app = useApp();
  const segs = app.gogglesOf(f).links.filter((x) => x.info).sort((a, b) => a.link.offset - b.link.offset);
  if (!segs.length) return null;
  const out = f.gogglesOut;
  const need = app.gogglesMergeNeeded(f);
  const v = out?.record.verified;
  return (
    <section class="gmerge neu-inset">
      <h4 class="panel-h"><Glasses size={15} strokeWidth={1.9} /> {t("gm.title")}</h4>
      <p class="mono small muted">{segs.map((x) => x.link.file).join(" + ")}</p>
      {segs.length === 1 ? (
        <p class="note">{t("gm.single")}</p>
      ) : job?.phase === "gmerge" ? (
        <p class="note"><Spinner size={13} /> {t("run.gmerging")}</p>
      ) : !need && out && v ? (
        <>
          <p class={`verify ${v.frames === v.sourceFrames ? "ok" : "bad"}`}>
            <Check size={15} strokeWidth={2.5} />
            <span class="num">{t("verify.ok", { a: v.frames.toLocaleString(), b: v.sourceFrames.toLocaleString() })}</span>
            <span class="muted num">{t("verify.duration", { d: fmtDur(v.duration) })}</span>
          </p>
          <p class="note"><FolderOpen size={14} strokeWidth={2} /> {t("out.location", { path: `2_ready/${out.name}` })}</p>
        </>
      ) : f.status === "pending" ? (
        <p class="note">{t("gm.withMerge", { n: segs.length })}</p>
      ) : (
        <div class="row">
          <span class="note grow">{t("gm.todo", { n: segs.length })}</span>
          <button class="soft-btn sm" disabled={!!app.job} onClick={() => app.run(f, { merge: false, overlay: false, goggles: true })}>
            <Merge size={14} /> {t("gm.run")}
          </button>
        </div>
      )}
    </section>
  );
}
