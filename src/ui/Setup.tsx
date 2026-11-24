// 폴더 설정 (흐름도형): 프로젝트 폴더를 고르면 하위 폴더 이름으로 칸을 채우고, 칸마다 바꿀 수 있다.
//   기체마다:  [원본] → [① 병합본] → [③ HUD]
//   공용:      [고글 원본] → [② 고글 병합본] → (각 기체 ③)
// 기체 폴더(<기체>/raw)가 없으면 단일 기체: 예전 이름(aircraft_raw, 2_ready …)으로 한 줄.
import { Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ArrowRight, Check, Drone, FolderOpen, Gauge, Glasses, Layers, Merge, Plus, ScrollText, TriangleAlert, X } from "lucide-preact";
import { useApp } from "../app.tsx";
import { t } from "../i18n.ts";
import { countMedia, guessFor, isReadonlyPick, pickKey, type AircraftSlot, type PickKey, type RoleGuess, type RolePicks } from "../roles.ts";
import { RAW_RE } from "../store.ts";
import { GOGGLES_RE } from "../goggles.ts";
import { FamilyLine, Spinner } from "./Shell.tsx";

type SlotState = "found" | "create" | "none" | "denied";
interface Slot {
  name: string | null; // 폴더 이름 (none 이면 null)
  state: SlotState;
  count?: number;
  picked: boolean; // 사용자가 직접 고름
}
interface Plan {
  aircraft: string[]; // 기체 id (단일 기체 = ["default"])
  multi: boolean;
  slots: Partial<Record<PickKey, Slot>>;
}

const RAW_MP4 = new RegExp(RAW_RE.source.replace("(MP4|LRF|SRT)", "MP4"), "i");
const countRe = (k: PickKey): [RegExp, number] | null =>
  k.endsWith(":raw") ? [RAW_MP4, 0]
  : k.endsWith(":merged") ? [/_merged\.mp4$/i, 0]
  : k.endsWith(":hud") ? [/_hud\.mp4$/i, 0]
  : k === "gogglesRaw" ? [GOGGLES_RE, 3]
  : k === "gogglesMerged" ? [/_goggles\.mp4$/i, 0]
  : null;
const OPTIONAL: PickKey[] = ["gogglesRaw", "logs"];

// 추정값 → 칸 이름: [폴더 경로(프로젝트 기준), 새로 만들지]
function guessed(g: RoleGuess, k: PickKey): [string | null, boolean] {
  const m = /^aircraft:(.+):(raw|merged|hud)$/.exec(k);
  if (m) {
    const [, id, slot] = m;
    if (id !== "default") return [`${id}/${slot}`, slot !== "raw"];
    if (slot === "raw") return [g.droneRaw, false];
    const x = slot === "merged" ? g.droneMerged : g.hud;
    return [x.name, x.create];
  }
  if (k === "gogglesRaw") return [g.gogglesRaw, false];
  if (k === "gogglesMerged") return [g.gogglesMerged.name, g.gogglesMerged.create];
  return [g.logs, false];
}

async function dirAt(project: FileSystemDirectoryHandle, path: string) {
  if (path === ".") return project;
  let h = project;
  for (const part of path.split("/")) h = await h.getDirectoryHandle(part);
  return h;
}

async function planFor(project: FileSystemDirectoryHandle, picks: RolePicks): Promise<Plan> {
  const g = await guessFor(project, !!picks.gogglesRaw);
  const multi = g.aircraft.length > 0;
  const aircraft = multi ? g.aircraft : ["default"];
  const keys: PickKey[] = [...aircraft.flatMap((id) => (["raw", "merged", "hud"] as AircraftSlot[]).map((s) => pickKey(id, s))), "gogglesRaw", "gogglesMerged", "logs"];
  const slots: Plan["slots"] = {};
  for (const k of keys) {
    let handle: FileSystemDirectoryHandle | null = null;
    let slot: Slot;
    if (k in picks && picks[k]) {
      handle = picks[k]!;
      slot = { name: handle.name, state: "found", picked: true };
    } else if (k in picks && OPTIONAL.includes(k)) {
      slot = { name: null, state: "none", picked: true };
    } else {
      const [name, create] = guessed(g, k);
      if (!name) slot = { name: null, state: "none", picked: false };
      else if (create && !(handle = await dirAt(project, name).catch(() => null))) slot = { name, state: "create", picked: false };
      else if (create) slot = { name, state: "found", picked: false };
      else {
        handle = await dirAt(project, name).catch(() => null);
        slot = { name: name === "." ? project.name : name, state: handle ? "found" : "denied", picked: false };
      }
    }
    const c = countRe(k);
    if (handle && c) {
      try {
        slot.count = await countMedia(handle, c[0], c[1]);
      } catch {
        slot.state = "denied";
      }
    }
    slots[k] = slot;
  }
  return { aircraft, multi, slots };
}

const AIRCRAFT_NAME = /^[a-z0-9_-]{1,32}$/;

export function Setup({ modal = false }: { modal?: boolean }) {
  const app = useApp();
  const [project, setProject] = useState<FileSystemDirectoryHandle | null>(app.savedProject?.project ?? null);
  const [picks, setPicks] = useState<RolePicks>(app.savedProject?.picks ?? {});
  const [plan, setPlan] = useState<Plan | null>(null);
  const [needAccess, setNeedAccess] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");

  const refresh = async (p = project, k = picks) => {
    if (!p) return setPlan(null);
    try {
      const perm = typeof (p as any).queryPermission === "function" ? await (p as any).queryPermission({ mode: "readwrite" }) : "granted";
      if (perm !== "granted") return setNeedAccess(true);
      setNeedAccess(false);
      setPlan(await planFor(p, k));
    } catch {
      setNeedAccess(true);
    }
  };
  useEffect(() => void refresh(), [project, picks]);

  const pickProject = async () => {
    const h = await app.pickDir("project");
    if (!h) return;
    const same = project && (await project.isSameEntry(h).catch(() => false));
    setProject(h);
    if (!same) setPicks({});
  };
  const pickRole = async (k: PickKey) => {
    const h = await app.pickDir(k);
    if (h) setPicks({ ...picks, [k]: h });
  };
  const resetRole = (k: PickKey) => {
    const next = { ...picks };
    delete next[k];
    setPicks(next);
  };
  const grant = async () => {
    if (!project) return;
    try {
      if ((await (project as any).requestPermission({ mode: "readwrite" })) === "granted") refresh();
    } catch {}
  };
  // 기체 추가 = 프로젝트에 <이름>/raw 폴더 만들기 (원본은 사용자가 거기에 복사)
  const addAircraft = async () => {
    if (!project || !AIRCRAFT_NAME.test(newName)) return;
    const base = await project.getDirectoryHandle(newName, { create: true });
    await base.getDirectoryHandle("raw", { create: true });
    setNewName("");
    refresh();
  };
  const start = async () => {
    if (!project) return;
    setBusy(true);
    await app.openProject(project, picks);
    setBusy(false);
  };

  const modelOf = (id: string) => app.idx?.aircraft.find((a) => a.id === id)?.model;

  const cell = (k: PickKey, label: string, icon: preact.ComponentChild, cls = "") => {
    const s = plan?.slots[k];
    const optional = OPTIONAL.includes(k);
    const ro = isReadonlyPick(k);
    const warn = s?.state === "denied" || (k.endsWith(":raw") && s?.state === "found" && s.count === 0);
    return (
      <div class={`flow-node ${cls} ${s?.state ?? ""} ${warn ? "warn" : ""}`}>
        <div class="flow-node-head">
          {icon}
          <b>{label}</b>
          {ro && <span class="tag">{t("role.readonly")}</span>}
        </div>
        <p class="flow-path mono small">
          {!s ? "…" : s.name ?? t("role.none")}
          {s?.count !== undefined && <span class="muted"> · {t("role.count", { n: s.count })}</span>}
        </p>
        <div class="flow-node-foot">
          {s?.state === "found" && !s.picked && <span class="tag ok">{t("role.found")}</span>}
          {s?.state === "create" && <span class="tag new">{t("role.create")}</span>}
          {s?.state === "denied" && <span class="tag warn"><TriangleAlert size={12} /> {t("gfolder.missing")}</span>}
          {warn && s?.state !== "denied" && <span class="tag warn"><TriangleAlert size={12} /> {t("role.empty")}</span>}
          <span class="grow" />
          {s?.picked && <button class="text-btn sm" onClick={() => resetRole(k)}>{t("role.auto")}</button>}
          {optional && s?.state !== "none" && <button class="icon-btn sm" onClick={() => setPicks({ ...picks, [k]: null })} aria-label={t("role.none")} title={t("role.none")}><X size={13} /></button>}
          <button class="soft-btn sm" onClick={() => pickRole(k)} disabled={!project}>{s?.state === "none" ? t("setup.pick") : t("setup.change")}</button>
        </div>
      </div>
    );
  };

  const body = (
    <section class={`setup-card glass ${modal ? "modal" : ""}`}>
      {!modal && <span class="brand-mark lg"><Drone size={28} strokeWidth={1.6} /></span>}
      <div>
        <h1>{modal ? t("setup.title") : t("empty.title")}</h1>
        <p class="lead">{t("setup.lead")}</p>
      </div>
      <div class={`flow-project ${project ? "set" : ""}`}>
        <FolderOpen size={20} strokeWidth={1.8} />
        <div class="grow">
          <b>{t("setup.project")}</b>
          <p class="muted small">{project ? project.name : t("setup.projectHint")}</p>
        </div>
        {needAccess && <button class="clay-btn sm" onClick={grant}>{t("gfolder.reconnect")}</button>}
        <button class={project ? "soft-btn sm" : "clay-btn sm"} onClick={pickProject}>{project ? t("setup.change") : t("setup.pick")}</button>
      </div>
      {project && !needAccess && plan && (
        <>
          <div class="flow" role="group" aria-label={t("a11y.pipeline")}>
            <span class="flow-stage">{t("flow.raw")}</span>
            <span />
            <span class="flow-stage">{t("flow.merge")}</span>
            <span />
            <span class="flow-stage">{t("flow.compose")}</span>
            {plan.aircraft.map((id) => {
              const m = modelOf(id);
              const name = id === "default" ? t("role.droneRaw") : m ? `${id} · ${m}` : id;
              return (
                <Fragment key={id}>
                  {cell(pickKey(id, "raw"), name, <Drone size={16} strokeWidth={1.9} />)}
                  <ArrowRight class="flow-arrow" size={18} />
                  {cell(pickKey(id, "merged"), t("role.droneMerged"), <Merge size={16} strokeWidth={1.9} />)}
                  <ArrowRight class="flow-arrow" size={18} />
                  {cell(pickKey(id, "hud"), t("role.hud"), <Gauge size={16} strokeWidth={1.9} />)}
                </Fragment>
              );
            })}
            {cell("gogglesRaw", t("role.gogglesRaw"), <Glasses size={16} strokeWidth={1.9} />, "shared")}
            <ArrowRight class="flow-arrow" size={18} />
            {cell("gogglesMerged", t("role.gogglesMerged"), <Layers size={16} strokeWidth={1.9} />, "shared")}
            <ArrowRight class="flow-arrow up" size={18} />
            <p class="flow-note small muted">{t("aircraft.sharedGoggles")}</p>
          </div>
          {plan.multi && (
            <div class="flow-add">
              <input class="neu-inset" value={newName} placeholder={t("aircraft.name")} onInput={(e) => setNewName((e.target as HTMLInputElement).value.trim().toLowerCase())} aria-label={t("aircraft.name")} />
              <button class="soft-btn sm" onClick={addAircraft} disabled={!AIRCRAFT_NAME.test(newName)}><Plus size={14} /> {t("aircraft.add")}</button>
              <span class="small muted">{t("aircraft.nameRule")}</span>
            </div>
          )}
          {cell("logs", t("role.logs"), <ScrollText size={16} strokeWidth={1.9} />, "wide")}
        </>
      )}
      <div class="welcome-actions">
        {modal && <button class="soft-btn" onClick={() => app.setShowSetup(false)}>{t("proj.back")}</button>}
        <button class="clay-btn" onClick={start} disabled={!project || needAccess || busy || app.busy}>
          {busy ? <Spinner size={18} /> : <Check size={18} strokeWidth={2.2} />} {modal ? t("setup.apply") : t("setup.start")}
        </button>
      </div>
      {!modal && <p class="fine">{t("empty.privacy")}</p>}
      {!modal && <FamilyLine />}
    </section>
  );
  if (modal) return <div class="setup-backdrop" onClick={(e) => e.target === e.currentTarget && app.setShowSetup(false)}>{body}</div>;
  return (
    <div class="welcome">
      <div class="ambient welcome-ambient" aria-hidden="true" />
      {body}
    </div>
  );
}
