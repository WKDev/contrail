// 폴더 설정 (흐름도형): 프로젝트 폴더를 고르면 하위 폴더 이름으로 역할을 채우고, 칸마다 바꿀 수 있다.
//   원본(읽기 전용)          병합                 합성
//   [드론 원본]   →  [① 드론 병합본]  ↘
//                                       [③ HUD]
//   [고글 원본]   →  [② 고글 병합본]  ↗
import { useEffect, useState } from "preact/hooks";
import { ArrowRight, Check, Drone, FolderOpen, Gauge, Glasses, Layers, Merge, ScrollText, TriangleAlert, X } from "lucide-preact";
import { useApp } from "../app.tsx";
import { t } from "../i18n.ts";
import { countMedia, guessFor, READONLY_ROLES, type Role, type RoleGuess, type RolePicks } from "../roles.ts";
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

const COUNT_RE: Partial<Record<Role, [RegExp, number]>> = {
  droneRaw: [new RegExp(RAW_RE.source.replace("(MP4|LRF|SRT)", "MP4"), "i"), 0],
  gogglesRaw: [GOGGLES_RE, 3],
  droneMerged: [/_merged\.mp4$/i, 0],
  gogglesMerged: [/_goggles\.mp4$/i, 0],
  hud: [/_hud\.mp4$/i, 0],
};

const guessName = (g: RoleGuess, r: Role): { name: string | null; create: boolean } => {
  if (r === "droneRaw") return { name: g.droneRaw, create: false };
  if (r === "gogglesRaw") return { name: g.gogglesRaw, create: false };
  if (r === "logs") return { name: g.logs, create: false };
  return g[r];
};

async function slotsFor(project: FileSystemDirectoryHandle, picks: RolePicks): Promise<Record<Role, Slot>> {
  const g = await guessFor(project, !!picks.gogglesRaw);
  const out = {} as Record<Role, Slot>;
  for (const r of ["droneRaw", "gogglesRaw", "droneMerged", "gogglesMerged", "hud", "logs"] as Role[]) {
    const picked = r in picks;
    const pick = picks[r];
    let handle: FileSystemDirectoryHandle | null = null;
    let slot: Slot;
    if (picked && pick) {
      handle = pick;
      slot = { name: pick.name, state: "found", picked: true };
    } else if (picked && pick === null && (r === "gogglesRaw" || r === "logs")) {
      slot = { name: null, state: "none", picked: true };
    } else {
      const gn = guessName(g, r);
      if (!gn.name) slot = { name: null, state: "none", picked: false };
      else if (gn.create) slot = { name: gn.name, state: "create", picked: false };
      else {
        handle = gn.name === "." ? project : await project.getDirectoryHandle(gn.name).catch(() => null);
        slot = { name: gn.name === "." ? project.name : gn.name, state: "found", picked: false };
      }
    }
    const c = COUNT_RE[r];
    if (handle && c) {
      try {
        slot.count = await countMedia(handle, c[0], c[1]);
      } catch {
        slot.state = "denied";
      }
    }
    out[r] = slot;
  }
  return out;
}

export function Setup({ modal = false }: { modal?: boolean }) {
  const app = useApp();
  const [project, setProject] = useState<FileSystemDirectoryHandle | null>(app.savedProject?.project ?? null);
  const [picks, setPicks] = useState<RolePicks>(app.savedProject?.picks ?? {});
  const [slots, setSlots] = useState<Record<Role, Slot> | null>(null);
  const [needAccess, setNeedAccess] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = async (p = project, k = picks) => {
    if (!p) return setSlots(null);
    try {
      const perm = typeof (p as any).queryPermission === "function" ? await (p as any).queryPermission({ mode: "readwrite" }) : "granted";
      if (perm !== "granted") return setNeedAccess(true);
      setNeedAccess(false);
      setSlots(await slotsFor(p, k));
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
  const pickRole = async (r: Role) => {
    const h = await app.pickDir(r);
    if (h) setPicks({ ...picks, [r]: h });
  };
  const clearRole = (r: Role) => setPicks({ ...picks, [r]: null });
  const resetRole = (r: Role) => {
    const next = { ...picks };
    delete next[r];
    setPicks(next);
  };
  const grant = async () => {
    if (!project) return;
    try {
      if ((await (project as any).requestPermission({ mode: "readwrite" })) === "granted") refresh();
    } catch {}
  };
  const start = async () => {
    if (!project) return;
    setBusy(true);
    await app.openProject(project, picks);
    setBusy(false);
  };

  const cell = (r: Role, icon: preact.ComponentChild, cls = "") => {
    const s = slots?.[r];
    const optional = r === "gogglesRaw" || r === "logs";
    const ro = READONLY_ROLES.includes(r);
    const warn = s?.state === "denied" || (r === "droneRaw" && s?.state === "found" && s.count === 0);
    return (
      <div class={`flow-node ${cls} ${s?.state ?? ""} ${warn ? "warn" : ""}`}>
        <div class="flow-node-head">
          {icon}
          <b>{t(`role.${r}` as any)}</b>
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
          {s?.picked && <button class="text-btn sm" onClick={() => resetRole(r)} title={t("role.auto")}>{t("role.auto")}</button>}
          {optional && s?.state !== "none" && <button class="icon-btn sm" onClick={() => clearRole(r)} aria-label={t("role.none")} title={t("role.none")}><X size={13} /></button>}
          <button class="soft-btn sm" onClick={() => pickRole(r)} disabled={!project}>{s?.state === "none" ? t("setup.pick") : t("setup.change")}</button>
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
      {project && !needAccess && (
        <>
          <div class="flow" role="group" aria-label={t("a11y.pipeline")}>
            <span class="flow-stage">{t("flow.raw")}</span>
            <span />
            <span class="flow-stage">{t("flow.merge")}</span>
            <span />
            <span class="flow-stage">{t("flow.compose")}</span>
            {cell("droneRaw", <Drone size={16} strokeWidth={1.9} />, "r1")}
            <ArrowRight class="flow-arrow r1" size={18} />
            {cell("droneMerged", <Merge size={16} strokeWidth={1.9} />, "r1")}
            <ArrowRight class="flow-arrow down r1" size={18} />
            {cell("hud", <Gauge size={16} strokeWidth={1.9} />, "hud")}
            {cell("gogglesRaw", <Glasses size={16} strokeWidth={1.9} />, "r2")}
            <ArrowRight class="flow-arrow r2" size={18} />
            {cell("gogglesMerged", <Layers size={16} strokeWidth={1.9} />, "r2")}
            <ArrowRight class="flow-arrow up r2" size={18} />
          </div>
          {cell("logs", <ScrollText size={16} strokeWidth={1.9} />, "wide")}
        </>
      )}
      <div class="welcome-actions">
        {modal && <button class="soft-btn" onClick={() => app.setShowSetup(false)}>{t("proj.back")}</button>}
        <button class="clay-btn" onClick={start} disabled={!project || needAccess || busy || !!app.job}>
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
