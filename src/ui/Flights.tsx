import { useMemo, useState } from "preact/hooks";
import { ArrowDownUp, Check, CircleCheck, Clock, CloudUpload, Drone, FolderOpen, Gauge, Glasses, Layers, LayoutGrid, ScrollText, Link2, List, Search } from "lucide-preact";
import { useApp, type Job } from "../app.tsx";
import type { Flight, Join } from "../library.ts";
import { fmtDay, fmtDur, fmtSize, fmtTime, t } from "../i18n.ts";
import { flightTitle } from "../library.ts";
import { Spinner } from "./Shell.tsx";

const MODE_KEY = "dji-uploader-view";
export function FlightsView() {
  const app = useApp();
  const [mode, setModeRaw] = useState<"grid" | "list">(() => {
    try {
      return localStorage.getItem(MODE_KEY) === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });
  const setMode = (m: "grid" | "list") => {
    setModeRaw(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {}
  };
  const flights = useMemo(() => {
    let fl = app.lib?.flights ?? [];
    if (app.view === "pending") fl = fl.filter((f) => f.status === "pending");
    if (app.view === "done") fl = fl.filter((f) => f.status === "done");
    if (app.day) fl = fl.filter((f) => f.day === app.day);
    const q = app.query.trim().toLowerCase();
    if (q) {
      fl = fl.filter((f) => {
        const title = flightTitle(f, app.state, (n) => t("flight", { n })).toLowerCase();
        return title.includes(q) || fmtDay(f.start).toLowerCase().includes(q) || fmtTime(f.start).includes(q) || f.clips.some((c) => c.name.toLowerCase().includes(q));
      });
    }
    return [...fl].sort((a, b) => (app.sortNew ? b.start - a.start : a.start - b.start));
  }, [app.lib, app.view, app.day, app.query, app.sortNew, app.state.prefs]);

  const groups = useMemo(() => {
    const m = new Map<string, Flight[]>();
    for (const f of flights) m.set(f.day, [...(m.get(f.day) ?? []), f]);
    return [...m.values()];
  }, [flights]);

  return (
    <>
      <header class="toolbar glass">
        <label class="search neu-inset">
          <Search size={16} strokeWidth={1.75} />
          <input value={app.query} onInput={(e) => app.setQuery((e.target as HTMLInputElement).value)} placeholder={t("search")} aria-label={t("search")} />
        </label>
        <div class="seg-control neu-inset" role="radiogroup" aria-label="view">
          <button role="radio" aria-checked={mode === "grid"} class={mode === "grid" ? "on" : ""} onClick={() => setMode("grid")} aria-label="grid"><LayoutGrid size={15} strokeWidth={1.75} /></button>
          <button role="radio" aria-checked={mode === "list"} class={mode === "list" ? "on" : ""} onClick={() => setMode("list")} aria-label="list"><List size={15} strokeWidth={1.75} /></button>
        </div>
        <BatchButton />
        <button class="soft-btn" onClick={() => app.setSortNew(!app.sortNew)}>
          <ArrowDownUp size={15} strokeWidth={1.75} /> {app.sortNew ? t("sort.new") : t("sort.old")}
        </button>
      </header>
      <div class="scroll">
        {app.loading && !app.lib ? (
          <SkeletonList />
        ) : !app.lib?.flights.length ? (
          <div class="empty">
            <FolderOpen size={36} strokeWidth={1.4} />
            <h2>{t("empty.noFlights")}</h2>
            <p>{t("empty.noFlightsHint")}</p>
          </div>
        ) : !flights.length ? (
          <div class="empty"><p>{t("empty.noneHere")}</p></div>
        ) : (
          groups.map((g) => (
            <section class={`day ${mode}`} key={g[0].day}>
              <h2 class="day-head">
                {fmtDay(g[0].start)}
                <span>{t("day.summary", { f: g.length, c: g.reduce((a, f) => a + f.clips.length, 0) })}</span>
              </h2>
              {g.map((f) => <FlightRow key={f.id} f={f} compact={mode === "list"} />)}
            </section>
          ))
        )}
      </div>
    </>
  );
}

function FlightRow({ f, compact }: { f: Flight; compact: boolean }) {
  const app = useApp();
  const sel = app.selected?.id === f.id;
  const running = app.job?.flightId === f.id ? app.job : null;
  const shown = f.clips.slice(0, compact ? 1 : 5);
  const cols = Math.min(5, Math.max(3, f.clips.length));
  return (
    <div
      class={`flight ${compact ? "compact" : ""} ${sel ? "selected" : ""} ${running ? "running" : ""}`}
      onClick={() => app.select(f.id)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), app.select(f.id))}
      tabIndex={0}
      role="button"
      aria-pressed={sel}
    >
      <div class="flight-head">
        <h3>{flightTitle(f, app.state, (n) => t("flight", { n }))}</h3>
        <span class="meta">
          {fmtTime(f.start)} – {fmtTime(f.end)} · {t("flight.clips", { n: f.clips.length })} · <span class="num">{fmtDur(f.duration)}</span> · <span class="num">{fmtSize(f.clips.reduce((x, c) => x + c.size, 0) || f.size)}</span>
        </span>
        <StatusChip f={f} job={running} />
      </div>
      <div class="thumbs" style={compact ? undefined : { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {shown.map((c) => (
          <figure class="thumb" key={c.stem}>
            {app.thumb(c.stem) ? <img src={app.thumb(c.stem)} alt="" loading="lazy" /> : <div class="thumb-ph" />}
            <figcaption class="num">{fmtDur(c.duration)}</figcaption>
          </figure>
        ))}
        {!compact && f.clips.length > shown.length && <div class="thumb more">+{f.clips.length - shown.length}</div>}
      </div>
      {f.clips.length > 1 && <MergeBar f={f} job={running} />}
      <Stages f={f} />
    </div>
  );
}

// 카드 아래 작업 단계: 드론 병합 · 고글 · HUD · (YouTube). ok = 끝남, todo = 할 일 있음, off = 해당 없음
type StageState = "ok" | "todo" | "off";
// 대기 중인 비행을 한 번에: 병합 + HUD 영상 (비행마다 차례로, 중단 가능)
function BatchButton() {
  const app = useApp();
  const todo = useMemo(() => app.batchTodo(), [app.lib, app.state.prefs, app.state.goggles, app.idx]);
  if (!todo.length) return null;
  const nMerge = todo.filter((x) => x.f.status === "pending").length;
  const nHud = todo.filter((x) => x.overlay).length;
  return (
    <button class="clay-btn batch-btn" disabled={!!app.job} onClick={app.runAll} title={t("batch.hint", { a: nMerge, b: nHud })}>
      <Layers size={16} strokeWidth={2} /> {t("batch.run", { n: todo.length })}
    </button>
  );
}

export function stagesOf(app: ReturnType<typeof useApp>, f: Flight) {
  const out: { key: string; icon: preact.ComponentChild; state: StageState; label: string }[] = [];
  const multi = f.clips.length > 1;
  out.push({
    key: "drone", icon: <Drone size={13} strokeWidth={2} />,
    state: f.status === "done" ? "ok" : multi ? "todo" : "off",
    label: multi ? (f.status === "done" ? t("stage.droneMerged", { n: f.clips.length }) : t("stage.droneTodo", { n: f.clips.length })) : f.status === "done" ? t("stage.droneReady") : t("stage.droneSingle"),
  });
  const g = app.gogglesOf(f);
  const linked = g.links.filter((x) => x.info).length;
  const gog: [StageState, string] =
    linked === 0 ? (g.candidates.length ? ["todo", t("stage.gogFound", { n: g.candidates.length })] : ["off", t("stage.gogNone")])
    : linked === 1 ? ["ok", t("stage.gogLinked")]
    : app.gogglesMergeNeeded(f) ? ["todo", t("stage.gogTodo", { n: linked })]
    : ["ok", t("stage.gogMerged", { n: linked })];
  out.push({ key: "goggles", icon: <Glasses size={13} strokeWidth={2} />, state: gog[0], label: gog[1] });
  if (app.idx?.logs.length || app.dirs?.logsExt) {
    const l = app.logOf(f);
    out.push({ key: "log", icon: <ScrollText size={13} strokeWidth={2} />, state: l ? "ok" : "off", label: l ? t("stage.logOk", { d: fmtDur(l.duration) }) : t("stage.logNone") });
  }
  out.push({ key: "hud", icon: <Gauge size={13} strokeWidth={2} />, state: f.overlay ? "ok" : "off", label: f.overlay ? t("stage.hudDone") : t("stage.hudTodo") });
  if (app.config.youtube) {
    const up = !!(f.youtubeId || f.overlayYoutubeId);
    out.push({ key: "yt", icon: <CloudUpload size={13} strokeWidth={2} />, state: up ? "ok" : "off", label: up ? t("stage.ytDone") : t("stage.ytTodo") });
  }
  return out;
}

function Stages({ f }: { f: Flight }) {
  const app = useApp();
  return (
    <ul class="pipes" aria-label={t("stage.label")}>
      {stagesOf(app, f).map((s) => (
        <li class={`pipe ${s.state}`} key={s.key}>
          {s.icon}
          <span>{s.label}</span>
          {s.state === "ok" && <Check size={12} strokeWidth={3} class="pipe-check" />}
        </li>
      ))}
    </ul>
  );
}

export function StatusChip({ f, job }: { f: Flight; job: Job | null }) {
  if (job) return <span class="chip run"><Spinner size={13} /> {t("status.running")}</span>;
  if (f.status === "pending") return <span class="chip pending">{f.clips.length > 1 ? t("status.pending") : t("status.single")}</span>;
  if (f.overlay) return <span class="chip overlay"><Gauge size={13} strokeWidth={2} /> {t("status.overlay")}</span>;
  return <span class="chip done"><CircleCheck size={13} strokeWidth={2} /> {t("status.done")}</span>;
}

export const joinLabel = (j: Join) => (j.reason === "auto" ? t("join.auto") : j.reason === "manual" ? t("join.manual") : t("join.scene"));

// 클립 길이에 비례한 막대 + 이음매. 병합 중이면 실제 진행만큼 차오른다.
export function MergeBar({ f, job, large }: { f: Flight; job: Job | null; large?: boolean }) {
  const total = f.duration || 1;
  const fill = job && (job.phase === "merge" || job.phase === "verify") ? (job.phase === "verify" ? 1 : job.done / Math.max(1, job.total)) : f.status === "done" ? 1 : 0;
  const verified = f.status === "done" && !!f.record?.verified && f.record.verified.frames === f.record.verified.sourceFrames;
  let acc = 0;
  return (
    <div class={`mergebar ${large ? "lg" : ""} ${f.status}`} role="img" aria-label={`${f.clips.length} clips, ${fmtDur(f.duration)}`}>
      <div class="segs">
        {f.clips.map((c, i) => {
          const start = acc / total;
          acc += c.duration;
          const segFill = Math.min(1, Math.max(0, (fill - start) / (c.duration / total)));
          return (
            <>
              {i > 0 && (
                <span class={`seam ${verified ? "verified" : f.joins[i - 1]?.reason ?? "auto"}`} title={joinLabel(f.joins[i - 1])}>
                  {verified ? <Check size={large ? 13 : 11} strokeWidth={3} /> : <Link2 size={large ? 13 : 11} strokeWidth={2.2} />}
                </span>
              )}
              <span class="seg" style={{ flexGrow: c.duration }}>
                <span class="seg-fill" style={{ transform: `scaleX(${segFill})` }} />
                {large && <span class="seg-label num">{fmtDur(c.duration)}</span>}
              </span>
            </>
          );
        })}
      </div>
      {large && (
        <div class="axis num">
          <span>0:00</span>
          <span><Clock size={12} strokeWidth={2} /> {fmtDur(f.duration)}</span>
        </div>
      )}
    </div>
  );
}

function SkeletonList() {
  return (
    <div class="skeleton-list" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div class="flight skeleton" key={i}>
          <div class="sk-line w40" />
          <div class="thumbs">{[0, 1, 2, 3].map((k) => <div class="thumb-ph" key={k} />)}</div>
          <div class="sk-line w90" />
        </div>
      ))}
    </div>
  );
}
