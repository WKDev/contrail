import { useMemo } from "preact/hooks";
import { CloudUpload, ExternalLink, EyeOff, FolderOpen, Glasses, Plus, RefreshCw, RotateCcw } from "lucide-preact";
import { useApp } from "../app.tsx";
import { matchGogglesForClips } from "../goggles.ts";
import { linksOf } from "../store.ts";
import { flightTitle } from "../library.ts";
import { fmtDay, fmtDur, fmtSize, fmtTime, t } from "../i18n.ts";
import { confidenceLabel } from "../sync.ts";

function ViewHead({ title, hint, children }: { title: string; hint?: string; children?: preact.ComponentChildren }) {
  return (
    <header class="toolbar glass view-head">
      <div>
        <h2>{title}</h2>
        {hint && <p class="muted small">{hint}</p>}
      </div>
      <div class="row">{children}</div>
    </header>
  );
}

export function GogglesView() {
  const app = useApp();
  const list = app.idx?.goggles ?? [];
  const flights = app.lib?.flights ?? [];
  const rows = useMemo(
    () =>
      list.map((g) => {
        const linked = flights.find((f) => linksOf(app.state, f.id).some((l) => l.file === g.name));
        const cand = linked ? null : flights.find((f) => matchGogglesForClips(f.clips, [g]).length > 0);
        return { g, linked, cand };
      }),
    [list, flights, app.state.goggles],
  );
  return (
    <>
      <ViewHead title={t("nav.goggles")} hint={app.dirs?.gogglesExt ? t("gog.viewHintLinked", { name: app.dirs.gogglesExt.name }) : t("gog.noneHint")}>
        <button class="soft-btn" onClick={app.linkGogglesFolder} disabled={!!app.job}><FolderOpen size={15} /> {app.dirs?.gogglesExt ? t("gfolder.change") : t("gfolder.pick")}</button>
        <button class="soft-btn" onClick={() => app.addGoggles("folder")} disabled={!!app.job} title={t("gog.fromSdHint")}><Glasses size={15} /> {t("gog.fromSd")}</button>
        <button class="soft-btn" onClick={() => app.addGoggles("files")} disabled={!!app.job}><Plus size={15} /> {t("gog.fromFiles")}</button>
      </ViewHead>
      <div class="scroll">
        {!rows.length ? (
          <div class="empty"><Glasses size={36} strokeWidth={1.4} /><p>{t("gog.listEmpty")}</p></div>
        ) : (
          <ul class="plain-list">
            {rows.map(({ g, linked, cand }) => {
              const f = linked ?? cand;
              const link = linked ? linksOf(app.state, linked.id).find((l) => l.file === g.name) ?? null : null;
              return (
                <li class="list-row" key={g.name}>
                  <Glasses size={18} strokeWidth={1.6} />
                  <div class="grow">
                    <b class="mono">{g.name}{g.linked && <span class="tag">{t("gog.inFolder")}</span>}</b>
                    <span class="muted small num">{fmtDay(g.start)} {fmtTime(g.start)} · {fmtDur(g.duration)} · {g.width}×{g.height}</span>
                  </div>
                  {f ? (
                    <button class="soft-btn sm" onClick={() => { app.setView("all"); app.select(f.id); }}>
                      {t("gog.matched", { flight: flightTitle(f, app.state, (n) => `${fmtDay(f.start)} ${t("flight", { n })}`) })}
                      {link && <span class={`dot ${confidenceLabel(link.score)}`} />}
                    </button>
                  ) : (
                    <span class="muted small">{t("gog.unmatched")}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

export function ExcludedView() {
  const app = useApp();
  const list = app.lib?.excluded ?? [];
  return (
    <>
      <ViewHead title={t("excluded.title")} hint={t("excluded.hint")}>
        <button class="soft-btn" onClick={app.tidyExcluded} disabled={!list.some((x) => x.dir === "root") || !!app.job}>{t("excluded.tidy")}</button>
      </ViewHead>
      <div class="scroll">
        {!list.length ? (
          <div class="empty"><EyeOff size={36} strokeWidth={1.4} /><p>{t("empty.noneHere")}</p></div>
        ) : (
          <ul class="plain-list">
            {list.map((x) => {
              const stem = x.name.replace(/\.mp4$/i, "");
              return (
                <li class="list-row" key={x.name}>
                  <div class="clip-thumb">{app.thumb(stem) ? <img src={app.thumb(stem)} alt="" /> : <div class="thumb-ph" />}</div>
                  <div class="grow">
                    <b class="mono">{x.name}</b>
                    <span class="muted small">
                      {x.duration !== undefined && <span class="num">{fmtDur(x.duration)} · </span>}
                      {x.reason === "수동" ? t("merge.exclude") : x.duration !== undefined && x.duration < app.config.minDuration ? t("merge.short", { s: x.duration.toFixed(1) }) : x.dir === "excluded" ? "_excluded" : ""}
                    </span>
                  </div>
                  <button
                    class="soft-btn sm"
                    onClick={() => (x.dir === "excluded" ? app.restoreExcluded(x.name) : app.setOverride(x.name, "excluded", false))}
                  >
                    <RotateCcw size={14} /> {t("excluded.restore")}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

export function UploadView() {
  const app = useApp();
  const done = (app.lib?.flights ?? []).filter((f) => f.status === "done").sort((a, b) => b.start - a.start);
  const used = app.config.dailyQuota - app.quotaLeft();
  const queue = done.flatMap((f) => [
    ...(!f.youtubeId && f.output?.ref ? [{ flight: f, overlay: false }] : []),
    ...(f.overlay?.ref && !f.overlayYoutubeId ? [{ flight: f, overlay: true }] : []),
  ]);
  return (
    <>
      <ViewHead title={t("up.title")} hint={t("up.quota", { u: used.toLocaleString(), d: app.config.dailyQuota.toLocaleString(), n: Math.max(0, Math.floor(app.quotaLeft() / app.perUpload)) })}>
        {app.account ? <span class="chip done">{app.account}</span> : <button class="soft-btn" onClick={app.ytLogin}>{t("up.login")}</button>}
        <button class="soft-btn" onClick={app.ytSync} disabled={!!app.job}><RefreshCw size={14} /> {t("up.sync")}</button>
        <button class="soft-btn" onClick={() => app.ytUpload(queue)} disabled={!queue.length || !!app.job}><CloudUpload size={16} /> {t("up.queue")} ({queue.length})</button>
      </ViewHead>
      <div class="scroll">
        <ul class="plain-list">
          {done.map((f) => (
            <li class="list-row" key={f.id}>
              <div class="clip-thumb">{app.thumb(f.clips[0].stem) ? <img src={app.thumb(f.clips[0].stem)} alt="" /> : <div class="thumb-ph" />}</div>
              <div class="grow">
                <b>{flightTitle(f, app.state, (n) => `${fmtDay(f.start)} ${t("flight", { n })}`)}</b>
                <span class="muted small num">{fmtDur(f.duration)} · {fmtSize(f.size)}</span>
              </div>
              {f.youtubeId ? (
                <a class="chip done" href={`https://youtu.be/${f.youtubeId}`} target="_blank" rel="noreferrer">{t("up.original")} <ExternalLink size={12} strokeWidth={2} /></a>
              ) : f.output?.ref ? (
                <button class="soft-btn sm" disabled={!!app.job} onClick={() => app.ytUpload([{ flight: f, overlay: false }])}>{t("up.original")}</button>
              ) : null}
              {f.overlay &&
                (f.overlayYoutubeId ? (
                  <a class="chip done" href={`https://youtu.be/${f.overlayYoutubeId}`} target="_blank" rel="noreferrer">{t("up.overlay")} <ExternalLink size={12} strokeWidth={2} /></a>
                ) : (
                  <button class="soft-btn sm" disabled={!!app.job} onClick={() => app.ytUpload([{ flight: f, overlay: true }])}>{t("up.overlay")}</button>
                ))}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
