// 라이브러리 위 단계 줄: ① 드론 병합 → ② 고글 → ③ HUD, 단계마다 대상 수 + 실행, 그리고 전부 순서대로
import { Fragment } from "preact";
import { useMemo } from "preact/hooks";
import { ArrowRight, Check, Drone, Gauge, Glasses, Play } from "lucide-preact";
import { useApp, type StepKey } from "../app.tsx";
import { t } from "../i18n.ts";

const STEPS: { key: StepKey; n: string; icon: preact.ComponentChild }[] = [
  { key: "drone", n: "①", icon: <Drone size={15} strokeWidth={1.9} /> },
  { key: "goggles", n: "②", icon: <Glasses size={15} strokeWidth={1.9} /> },
  { key: "hud", n: "③", icon: <Gauge size={15} strokeWidth={1.9} /> },
];

export function StepBar() {
  const app = useApp();
  const todo = useMemo(() => app.stepTodo(), [app.lib, app.state.prefs, app.state.goggles, app.idx]);
  if (!app.lib?.flights.length) return null;
  const busy = !!app.job;
  const total = todo.drone.length + todo.goggles.length + todo.hud.length;
  return (
    <nav class="stepbar glass" aria-label={t("a11y.pipeline")}>
      {STEPS.map((s, i) => {
        const n = todo[s.key].length;
        const running = app.batch?.step === s.key;
        return (
          <Fragment key={s.key}>
            {i > 0 && <ArrowRight class="stepbar-arrow" size={15} aria-hidden="true" />}
            <div class={`stepbar-step ${n ? "todo" : "ok"} ${running ? "run" : ""}`}>
              <span class="stepbar-label">{s.icon} {s.n} {t(`step.${s.key}`)}</span>
              {n ? <span class="num">{n}</span> : <Check size={14} strokeWidth={2.6} />}
              <button class="soft-btn sm" disabled={!n || busy} onClick={() => app.runStep(s.key)}>{t("step.run")}</button>
              {s.key === "hud" && todo.hudBlocked > 0 && <span class="small muted stepbar-note">{t("step.hudBlocked", { n: todo.hudBlocked })}</span>}
            </div>
          </Fragment>
        );
      })}
      <span class="grow" />
      <button class="clay-btn sm" disabled={!total || busy} onClick={() => app.runStep("all")}>
        <Play size={14} strokeWidth={2.2} /> {t("step.all")}
      </button>
    </nav>
  );
}
