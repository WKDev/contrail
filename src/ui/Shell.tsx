import { Component } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  ScrollText,
  Calendar, Check, CloudUpload, Drone, EyeOff, FolderOpen, Glasses, Layers, LoaderCircle, Merge, RefreshCw, Settings as SettingsIcon, CircleCheck, TriangleAlert, X,
} from "lucide-preact";
import { useApp, type View } from "../app.tsx";
import { fmtDayShort, t } from "../i18n.ts";
import { FlightsView } from "./Flights.tsx";
import { Project } from "./Project.tsx";
import { ExcludedView, GogglesView, UploadView } from "./Views.tsx";
import { SettingsSheet } from "./Settings.tsx";

export function Shell() {
  const app = useApp();
  if (!("showDirectoryPicker" in window) || typeof VideoDecoder === "undefined") return <Unsupported />;
  if (!app.dirs) return <Welcome />;
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
      pending: fl.filter((f) => f.status === "pending").length,
      done: fl.filter((f) => f.status === "done").length,
      goggles: app.idx?.goggles.length ?? 0,
      excluded: lib?.excluded.length ?? 0,
    };
  }, [lib, app.idx]);
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
        <span>{t("appName")}</span>
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
          <button class="ghost-btn" onClick={() => app.openFolder()} disabled={!!app.job}>{t("folder.change")}</button>
          <button class="icon-btn" onClick={() => app.setShowSettings(true)} title={t("nav.settings")} aria-label={t("nav.settings")}>
            <SettingsIcon size={17} strokeWidth={1.75} />
          </button>
        </div>
      </div>
    </aside>
  );
}

// 사이드바 아래: 드론 폴더 / 고글 폴더 상태
function FolderStatus() {
  const app = useApp();
  const st = app.idx?.gogglesExt ?? "none";
  const ext = app.dirs!.gogglesExt;
  const nGog = app.idx?.goggles.filter((g) => g.linked).length ?? 0;
  return (
    <div class="folders neu">
      <div class="folder-card">
        <Drone size={17} strokeWidth={1.75} />
        <div class="folder-meta">
          <span>{t("setup.drone")}</span>
          <b title={app.dirs!.root.name}>{app.dirs!.root.name || t("folder.unnamed")}</b>
        </div>
        <button class="icon-btn" onClick={app.refresh} title={t("folder.refresh")} aria-label={t("folder.refresh")} disabled={app.loading}>
          <RefreshCw size={15} strokeWidth={1.75} class={app.loading ? "spin" : ""} />
        </button>
      </div>
      <div class={`folder-card ${st === "missing" ? "warn" : ""}`}>
        {st === "missing" ? <TriangleAlert size={17} strokeWidth={1.75} /> : <Glasses size={17} strokeWidth={1.75} />}
        <div class="folder-meta">
          <span>{t("setup.goggles")}{ext && st === "ok" ? ` · ${t("gfolder.count", { n: nGog })}` : ""}</span>
          <b title={ext?.name}>{ext ? ext.name : t("gfolder.none")}</b>
          {st === "missing" && <span class="warn-text">{t("gfolder.missing")}</span>}
        </div>
        {st === "missing" ? (
          <button class="soft-btn sm" onClick={app.reconnectGoggles} disabled={!!app.job}>{t("gfolder.reconnect")}</button>
        ) : (
          <button class="icon-btn" onClick={app.linkGogglesFolder} disabled={!!app.job} title={ext ? t("gfolder.change") : t("gfolder.pick")} aria-label={ext ? t("gfolder.change") : t("gfolder.pick")}>
            <FolderOpen size={15} strokeWidth={1.75} />
          </button>
        )}
      </div>
      <LogsRow />
    </div>
  );
}

// 비행기록 폴더 (선택): 찾은 기록 수
function LogsRow() {
  const app = useApp();
  const ext = app.dirs!.logsExt;
  const st = app.idx?.logsExt ?? "none";
  const n = app.idx?.logs.length ?? 0;
  return (
    <div class={`folder-card ${st === "missing" ? "warn" : ""}`}>
      {st === "missing" ? <TriangleAlert size={17} strokeWidth={1.75} /> : <ScrollText size={17} strokeWidth={1.75} />}
      <div class="folder-meta">
        <span>{t("flog.folder")}{n ? ` · ${t("flog.count", { n })}` : ""}</span>
        <b title={ext?.name}>{ext ? ext.name : n ? t("flog.found") : t("flog.none")}</b>
        {st === "missing" && <span class="warn-text">{t("gfolder.missing")}</span>}
      </div>
      <button class="icon-btn" onClick={app.linkLogsFolder} disabled={!!app.job} title={t("flog.pick")} aria-label={t("flog.pick")}>
        <FolderOpen size={15} strokeWidth={1.75} />
      </button>
    </div>
  );
}

// 첫 화면: 드론 영상 폴더(필수)와 고글 녹화 폴더(선택)를 정하고 시작
function Welcome() {
  const app = useApp();
  const [drone, setDrone] = useState<FileSystemDirectoryHandle | null>(null);
  const [gog, setGog] = useState<FileSystemDirectoryHandle | null | undefined>(undefined); // undefined = 아직 안 정함, null = 고글 없음
  const [busy, setBusy] = useState(false);
  const d = drone ?? app.savedRoot;
  const g = gog === undefined ? app.savedGoggles : gog;
  const start = async () => {
    if (!d) return;
    setBusy(true);
    await app.openFolder(d, g ?? null);
    setBusy(false);
  };
  return (
    <div class="welcome">
      <div class="ambient welcome-ambient" aria-hidden="true" />
      <section class="welcome-card glass">
        <span class="brand-mark lg"><Drone size={28} strokeWidth={1.6} /></span>
        <div>
          <h1>{t("empty.title")}</h1>
          <p class="lead">{t("setup.lead")}</p>
        </div>
        <ol class="setup">
          <li class={`slot ${d ? "set" : ""}`}>
            <span class="step-dot">{d ? <Check size={14} strokeWidth={3} /> : 1}</span>
            <div class="grow">
              <div class="slot-title"><b>{t("setup.drone")}</b><span class="tag">{t("setup.required")}</span></div>
              <p class="muted small">{t("setup.droneHint")}</p>
              {d && <p class="slot-name"><FolderOpen size={14} strokeWidth={1.9} /> {d.name || t("folder.unnamed")}{!drone && <span class="tag">{t("setup.last")}</span>}</p>}
            </div>
            <button class={d ? "soft-btn sm" : "clay-btn sm"} onClick={async () => { const h = await app.pickDir("drone"); if (h) setDrone(h); }}>
              {d ? t("setup.change") : t("setup.pick")}
            </button>
          </li>
          <li class={`slot ${g ? "set" : ""}`}>
            <span class="step-dot">{g ? <Check size={14} strokeWidth={3} /> : 2}</span>
            <div class="grow">
              <div class="slot-title"><b>{t("setup.goggles")}</b><span class="tag">{t("setup.optional")}</span></div>
              <p class="muted small">{t("setup.gogglesHint")}</p>
              {g && <p class="slot-name"><Glasses size={14} strokeWidth={1.9} /> {g.name}{gog === undefined && <span class="tag">{t("setup.last")}</span>}</p>}
            </div>
            <div class="slot-actions">
              <button class="soft-btn sm" onClick={async () => { const h = await app.pickDir("goggles"); if (h) setGog(h); }}>
                {g ? t("setup.change") : t("setup.pick")}
              </button>
              {g && <button class="text-btn sm" onClick={() => setGog(null)}>{t("setup.noGoggles")}</button>}
            </div>
          </li>
        </ol>
        <div class="welcome-actions">
          <button class="clay-btn" onClick={start} disabled={!d || busy}>
            {busy ? <Spinner size={18} /> : <FolderOpen size={18} strokeWidth={1.9} />} {t("setup.start")}
          </button>
          {!g && <span class="muted small">{t("setup.laterHint")}</span>}
        </div>
        <p class="fine">{t("empty.privacy")}</p>
      </section>
    </div>
  );
}

function Unsupported() {
  return (
    <div class="welcome">
      <section class="welcome-card glass">
        <span class="brand-mark lg"><Drone size={28} strokeWidth={1.6} /></span>
        <h1>{t("appName")}</h1>
        <p class="lead">{t("empty.browser")}</p>
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
            <b>{t("batch.running")}</b>
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
