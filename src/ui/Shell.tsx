import { Component } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  ScrollText, Gauge,
  Calendar, Check, CloudUpload, Drone, EyeOff, FolderOpen, Glasses, Layers, LoaderCircle, Merge, RefreshCw, Settings as SettingsIcon, CircleCheck, TriangleAlert, X,
} from "lucide-preact";
import { useApp, type View } from "../app.tsx";
import { fmtDayShort, getLang, t } from "../i18n.ts";
import { FlightsView } from "./Flights.tsx";
import { Project } from "./Project.tsx";
import { ExcludedView, GogglesView, UploadView } from "./Views.tsx";
import { SettingsSheet } from "./Settings.tsx";
import { Setup } from "./Setup.tsx";
import { isPendingView } from "../steps.ts";
import type { Role } from "../roles.ts";

export function Shell() {
  const app = useApp();
  if (!("showDirectoryPicker" in window) || typeof VideoDecoder === "undefined") return <Unsupported />;
  if (!app.dirs) return <Setup />;
  const bg = app.selected ? app.thumb(app.selected.clips[0].stem) : undefined;
  const isFlights = app.view === "all" || app.view === "pending" || app.view === "done";
  if (app.selected) {
    return (
      <div class="shell project-mode" style={bg ? { "--amb": `url(${bg})` } : undefined}>
        <Guard key={app.selected.id} onBack={() => app.select(null)}>
          <Project f={app.selected} />
        </Guard>
        <Toasts />
        <JobCard />
        {app.showSettings && <SettingsSheet />}
        {app.showSetup && <Setup modal />}
      </div>
    );
  }
  return (
    <div class="shell">
      <Sidebar />
      <main class="main">
        <Guard key={app.view}>
          {isFlights && <FlightsView />}
          {app.view === "goggles" && <GogglesView />}
          {app.view === "excluded" && <ExcludedView />}
          {app.view === "upload" && <UploadView />}
        </Guard>
      </main>
      <Toasts />
      <JobCard />
      {app.showSettings && <SettingsSheet />}
      {app.showSetup && <Setup modal />}
    </div>
  );
}

// 화면 일부가 오류로 그려지지 않아도 앱 전체가 하얗게 죽지 않게: 오류 안내 + 다시 시도 / 돌아가기 / 오류 내용 복사
class Guard extends Component<{ onBack?: () => void; children: preact.ComponentChildren }, { err: Error | null }> {
  state = { err: null as Error | null };
  componentDidCatch(err: Error) {
    console.error(err);
    this.setState({ err });
  }
  render() {
    const { err } = this.state;
    if (!err) return this.props.children;
    const text = `${err.name}: ${err.message}\n${err.stack ?? ""}`.slice(0, 4000);
    return (
      <div class="empty crash" role="alert">
        <TriangleAlert size={34} strokeWidth={1.5} />
        <h2>{t("crash.title")}</h2>
        <p>{t("crash.hint")}</p>
        <code class="mono small">{err.message}</code>
        <div class="row">
          <button class="clay-btn" onClick={() => this.setState({ err: null })}>{t("crash.retry")}</button>
          {this.props.onBack && <button class="soft-btn" onClick={this.props.onBack}>{t("proj.back")}</button>}
          <button class="text-btn" onClick={() => navigator.clipboard?.writeText(text)}>{t("crash.copy")}</button>
        </div>
      </div>
    );
  }
}

function Sidebar() {
  const app = useApp();
  const lib = app.lib;
  const counts = useMemo(() => {
    const fl = lib?.flights ?? [];
    return {
      all: fl.length,
      pending: fl.filter((f) => isPendingView(app.stepsOf(f))).length,
      done: fl.filter((f) => !isPendingView(app.stepsOf(f))).length,
      goggles: app.idx?.goggles.length ?? 0,
      excluded: lib?.excluded.length ?? 0,
    };
  }, [lib, app.idx, app.state.prefs, app.state.goggles]);
  const days = useMemo(() => {
    const m = new Map<string, { n: number; start: number }>();
    for (const f of lib?.flights ?? []) {
      const e = m.get(f.day) ?? { n: 0, start: f.start };
      e.n++;
      m.set(f.day, e);
    }
    return [...m.entries()].sort((a, b) => b[1].start - a[1].start);
  }, [lib]);
  const item = (v: View, icon: preact.ComponentChild, label: string, n?: number) => (
    <button class={`nav-item ${app.view === v ? "on" : ""}`} onClick={() => { app.setView(v); app.setDay(null); }} aria-current={app.view === v ? "page" : undefined}>
      {icon}
      <span>{label}</span>
      {n !== undefined && <span class="count">{n}</span>}
    </button>
  );
  return (
    <aside class="sidebar glass">
      <div class="brand">
        <span class="brand-mark"><Drone size={18} strokeWidth={1.75} /></span>
        <span class="brand-text">
          <span>{t("appName")}</span>
          <a class="family-link" href={ouworkUrl()} target="_blank" rel="noopener">{t("family.short")}</a>
        </span>
      </div>
      <nav class="nav">
        {item("all", <Layers size={17} strokeWidth={1.75} />, t("nav.all"), counts.all)}
        {item("pending", <Merge size={17} strokeWidth={1.75} />, t("nav.pending"), counts.pending)}
        {item("done", <CircleCheck size={17} strokeWidth={1.75} />, t("nav.done"), counts.done)}
        {item("goggles", <Glasses size={17} strokeWidth={1.75} />, t("nav.goggles"), counts.goggles)}
        {item("excluded", <EyeOff size={17} strokeWidth={1.75} />, t("nav.excluded"), counts.excluded)}
        {app.config.youtube && item("upload", <CloudUpload size={17} strokeWidth={1.75} />, t("nav.upload"))}
      </nav>
      {days.length > 0 && (
        <>
          <div class="nav-label">{t("nav.dates")}</div>
          <nav class="nav days">
            {days.map(([d, e]) => (
              <button
                class={`nav-item ${app.day === d ? "on" : ""}`}
                onClick={() => {
                  app.setDay(app.day === d ? null : d);
                  if (app.view !== "all" && app.view !== "pending" && app.view !== "done") app.setView("all");
                }}
              >
                <Calendar size={16} strokeWidth={1.75} />
                <span>{fmtDayShort(e.start)}</span>
                <span class="count">{e.n}</span>
              </button>
            ))}
          </nav>
        </>
      )}
      <div class="sidebar-foot">
        <FolderStatus />
        <div class="foot-row">
          <button class="ghost-btn" onClick={() => app.setShowSetup(true)} disabled={app.busy}>{t("folder.change")}</button>
          <button class="icon-btn" onClick={() => app.setShowSettings(true)} title={t("nav.settings")} aria-label={t("nav.settings")}>
            <SettingsIcon size={17} strokeWidth={1.75} />
          </button>
        </div>
      </div>
    </aside>
  );
}

// 사이드바 아래: 역할별 폴더 상태. 원본 폴더를 못 읽으면 그 줄만 "다시 연결"
const ROLE_ICON: Record<Role, preact.ComponentChild> = {
  droneRaw: <Drone size={15} strokeWidth={1.75} />, gogglesRaw: <Glasses size={15} strokeWidth={1.75} />,
  droneMerged: <Merge size={15} strokeWidth={1.75} />, gogglesMerged: <Layers size={15} strokeWidth={1.75} />,
  hud: <Gauge size={15} strokeWidth={1.75} />, logs: <ScrollText size={15} strokeWidth={1.75} />,
};
function FolderStatus() {
  const app = useApp();
  const d = app.dirs!;
  const state = (r: Role) => (r === "gogglesRaw" ? app.idx?.gogglesState : r === "logs" ? app.idx?.logsState : "ok") ?? "none";
  const extra = (r: Role) =>
    r === "gogglesRaw" && state(r) === "ok" ? ` · ${t("gfolder.count", { n: app.idx?.goggles.filter((g) => g.linked).length ?? 0 })}`
    : r === "logs" && app.idx?.logs.length ? ` · ${t("flog.count", { n: app.idx.logs.length })}` : "";
  return (
    <div class="folders neu">
      <div class="folder-card">
        <FolderOpen size={17} strokeWidth={1.75} />
        <div class="folder-meta">
          <span>{t("setup.project")}</span>
          <b title={d.project.name}>{d.project.name || t("folder.unnamed")}</b>
        </div>
        <button class="icon-btn" onClick={app.refresh} title={t("folder.refresh")} aria-label={t("folder.refresh")} disabled={app.loading}>
          <RefreshCw size={15} strokeWidth={1.75} class={app.loading ? "spin" : ""} />
        </button>
      </div>
      <ul class="role-list">
        {(["droneRaw", "gogglesRaw", "droneMerged", "gogglesMerged", "hud", "logs"] as Role[]).map((r) => {
          const h = d[r] as FileSystemDirectoryHandle | null;
          const missing = state(r) === "missing";
          return (
            <li class={`role-row ${missing ? "warn" : ""} ${h ? "" : "off"}`} key={r}>
              {missing ? <TriangleAlert size={15} strokeWidth={1.75} /> : ROLE_ICON[r]}
              <span class="grow">{t(`role.${r}` as any)}{extra(r)}</span>
              <b class="mono" title={h?.name}>{h ? h.name : t("role.none")}</b>
              {missing && <button class="soft-btn sm" onClick={() => app.reconnect(r)} disabled={app.busy}>{t("gfolder.reconnect")}</button>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// OUWORK 제품군 표시 (ouwork.io 는 ?lang= 으로 언어를 이어받음)
// ouwork.io 는 한국어·영어만: 나머지 언어는 영어로
const ouworkUrl = () => `https://ouwork.io/?lang=${getLang() === "ko" ? "ko" : "en"}`;
export function FamilyLine() {
  return (
    <p class="family-line">
      <img src="/ouwork-mark.png" width="18" height="18" alt="" />
      <span>{t("family.line")}</span>
      <a href={ouworkUrl()} target="_blank" rel="noopener">{t("family.more")} ↗</a>
    </p>
  );
}

function Unsupported() {
  return (
    <div class="welcome">
      <section class="welcome-card glass">
        <span class="brand-mark lg"><Drone size={28} strokeWidth={1.6} /></span>
        <h1>{t("appName")}</h1>
        <p class="lead">{t("empty.browser")}</p>
        <FamilyLine />
      </section>
    </div>
  );
}

// 최근 기록을 토스트로 (오류는 닫을 때까지 유지)
function Toasts() {
  const { log } = useApp();
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const visible = log.filter((l) => !dismissed.has(l.t) && (l.err || now - l.t < 5000)).slice(0, 3);
  if (!visible.length) return null;
  return (
    <div class="toasts" role="status" aria-live="polite">
      {visible.map((l) => (
        <div class={`toast glass ${l.err ? "err" : ""}`} key={l.t}>
          {l.err ? null : <CircleCheck size={16} strokeWidth={2} />}
          <span>{l.msg}</span>
          <button class="icon-btn sm" aria-label={t("close")} onClick={() => setDismissed((s) => new Set(s).add(l.t))}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

// 특정 비행에 속하지 않는 작업(고글 가져오기 등) 진행 표시
const PHASE_TEXT: Record<string, Parameters<typeof t>[0]> = {
  merge: "run.merging", verify: "run.verifying", gmerge: "run.gmerging", tiles: "run.tiles", render: "run.rendering", goggles: "gog.syncing",
};
function JobCard() {
  const app = useApp();
  const j = app.job;
  const b = app.batch;
  if (b) {
    const inner = j ? Math.min(1, j.done / Math.max(1, j.total)) : 0;
    const pct = ((b.i - 1 + inner) / b.n) * 100;
    return (
      <div class="jobcard glass" role="status" aria-live="polite">
        <Spinner size={15} />
        <div class="grow">
          <div class="run-text">
            <b>{t(`step.${b.step}`)} · {t("batch.running")}</b>
            <span class="num">{b.i}/{b.n}</span>
          </div>
          <span class="small muted">{b.label}{j ? ` · ${t(PHASE_TEXT[j.phase] ?? "status.running")} ${Math.round(inner * 100)}%` : ""}</span>
          <div class="bar neu-inset"><div style={{ width: `${pct}%` }} /></div>
        </div>
        <button class="soft-btn sm" onClick={app.cancel}>{t("run.cancel")}</button>
      </div>
    );
  }
  if (!j || j.flightId) return null;
  const pct = Math.min(100, (j.done / Math.max(1, j.total)) * 100);
  return (
    <div class="jobcard glass" role="status" aria-live="polite">
      <Spinner size={15} />
      <div class="grow">
        <div class="run-text">
          <b>{j.phase === "scanGoggles" ? t("gog.scanning") : j.phase === "autoSync" ? t("gog.autoSyncing") : t("gog.copying")}</b>
          <span class="num">{j.phase === "copy" ? `${Math.round(pct)}%` : `${j.done}/${j.total}`}</span>
        </div>
        {j.label && <span class="mono small muted">{j.label}</span>}
        <div class="bar neu-inset"><div style={{ width: `${pct}%` }} /></div>
      </div>
      <button class="soft-btn sm" onClick={app.cancel}>{t("run.cancel")}</button>
    </div>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <LoaderCircle size={size} strokeWidth={2} class="spin" />;
}
