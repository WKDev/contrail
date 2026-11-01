import { useEffect, useRef, useState } from "preact/hooks";
import { X } from "lucide-preact";
import { defaultConfig, useApp, type Config } from "../app.tsx";
import { DEFAULT_SETTINGS } from "../plan.ts";
import { getLang, setLang, t, type Lang } from "../i18n.ts";

export function SettingsSheet() {
  const app = useApp();
  const [c, setC] = useState<Config>(app.config);
  const [lang, setL] = useState<Lang>(getLang());
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const close = () => app.setShowSettings(false);
  const num = (key: keyof Config, label: string, step = 0.1) => (
    <label class="field">
      <span>{label}</span>
      <input class="neu-inset" type="number" step={step} value={String(c[key])} onInput={(e) => setC({ ...c, [key]: Number((e.target as HTMLInputElement).value) })} />
    </label>
  );
  const text = (key: keyof Config, label: string, hint?: string) => (
    <label class="field">
      <span>{label}</span>
      <input class="neu-inset" value={String(c[key])} onInput={(e) => setC({ ...c, [key]: (e.target as HTMLInputElement).value.trim() })} />
      {hint && <small>{hint}</small>}
    </label>
  );
  return (
    <dialog ref={ref} class="sheet glass" onClose={close} onCancel={close}>
      <form
        method="dialog"
        onSubmit={() => {
          setLang(lang);
          app.saveConfig(c);
        }}
      >
        <header class="sheet-head">
          <h2>{t("set.title")}</h2>
          <button type="button" class="icon-btn" onClick={close} aria-label={t("close")}><X size={18} /></button>
        </header>
        <div class="sheet-body">
          <h3>{t("set.general")}</h3>
          <div class="seg-control neu-inset" role="radiogroup" aria-label={t("set.lang")}>
            {(["ko", "en"] as Lang[]).map((l) => (
              <button type="button" role="radio" aria-checked={lang === l} class={lang === l ? "on" : ""} onClick={() => setL(l)}>
                {l === "ko" ? "한국어" : "English"}
              </button>
            ))}
          </div>

          <h3>{t("set.auto")}</h3>
          <div class="grid3">
            {num("minDuration", t("set.minDuration"), 1)}
            {num("maxGap", t("set.maxGap"), 0.5)}
            {num("simMax", t("set.simMax"), 0.05)}
          </div>

          <h3>{t("set.overlay")}</h3>
          {text("mapsKey", t("set.mapsKey"), t("set.mapsHint"))}

          <h3>{t("set.youtube")}</h3>
          <label class="toggle">
            <span class="toggle-text">{t("set.youtubeOn")}<small>{t("set.youtubeHint")}</small></span>
            <input type="checkbox" role="switch" checked={c.youtube} onChange={(e) => setC({ ...c, youtube: (e.target as HTMLInputElement).checked })} />
            <span class="switch neu-inset" aria-hidden="true"><span class="knob" /></span>
          </label>
          {c.youtube && (
            <>
              {text("clientId", t("set.clientId"))}
              {text("playlist", t("set.playlist"))}
              <label class="field">
                <span>{t("set.privacy")}</span>
                <select class="neu-inset" value={c.privacy} onChange={(e) => setC({ ...c, privacy: (e.target as HTMLSelectElement).value as Config["privacy"] })}>
                  <option value="private">{t("set.private")}</option>
                  <option value="unlisted">{t("set.unlisted")}</option>
                  <option value="public">{t("set.public")}</option>
                </select>
              </label>
            </>
          )}
        </div>
        <footer class="sheet-foot">
          <button type="button" class="text-btn" onClick={() => setC({ ...c, ...DEFAULT_SETTINGS, mapsKey: c.mapsKey || defaultConfig.mapsKey })}>{t("set.defaults")}</button>
          <span class="spacer" />
          <button type="button" class="soft-btn" onClick={close}>{t("set.cancel")}</button>
          <button type="submit" class="clay-btn">{t("set.save")}</button>
        </footer>
      </form>
    </dialog>
  );
}
