import { $, icon } from "./dom";
import { animateContent, closeDialog, openDialog } from "./motion";
import { EQ_PRESETS, type Sound } from "./sound";

/**
 * The player's "音效" sheet: loudness normalisation, the equaliser (desktop),
 * crossfade length and the sleep timer. The sleep timer lives here too, since
 * it is the one thing on the sheet that runs on its own afterwards.
 */
type Options = {
  sound: Sound;
  desktop: boolean;
  audio: HTMLAudioElement;
  toast: (message: string) => void;
  /** Reload the current song at its position (to route it through the EQ). */
  reload: () => void;
  /** Loudness of the playing song, for turning normalisation on mid-song. */
  currentGain: () => number | undefined;
};
type Sleep =
  { mode: "off" } | { mode: "time"; endsAt: number } | { mode: "track" };

export function setupSoundPanel(o: Options) {
  let sleep: Sleep = { mode: "off" };
  let sleepTimer = 0,
    tick = 0;
  const dialog = document.createElement("dialog");
  dialog.id = "sound-dialog";
  dialog.setAttribute("aria-labelledby", "sound-title");
  document.body.append(dialog);
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeDialog(dialog);
  });
  const button = $("#sound-button");

  function sleepLabel() {
    if (sleep.mode === "track") return "本曲播完后停止";
    if (sleep.mode === "time") {
      const minutes = Math.max(
        1,
        Math.ceil((sleep.endsAt - Date.now()) / 60000),
      );
      return `${minutes} 分钟后停止`;
    }
    return "";
  }
  function renderButton() {
    const busy =
      sleep.mode !== "off" ||
      o.sound.normalize ||
      o.sound.preset !== "flat" ||
      o.sound.crossfade > 0;
    button.classList.toggle("active", busy);
    button.title = sleepLabel() || "音效与睡眠定时";
    button.dataset.sleep = sleep.mode;
  }
  function render() {
    renderButton();
    if (!dialog.open) return;
    const s = o.sound;
    const presets = Object.entries(EQ_PRESETS)
      .map(
        ([key, p]) =>
          `<button data-eq="${key}" aria-pressed="${s.preset === key}">${p.label}</button>`,
      )
      .join("");
    const sleeps: [string, string][] = [
      ["off", "关闭"],
      ["15", "15 分钟"],
      ["30", "30 分钟"],
      ["60", "60 分钟"],
      ["track", "本曲播完"],
    ];
    const active =
      sleep.mode === "track" ? "track" : sleep.mode === "off" ? "off" : "";
    dialog.innerHTML = `<button class="dialog-close icon-button" data-sound-close aria-label="关闭音效设置">${icon("X")}</button><h2 id="sound-title">音效</h2>
<section><label class="switch-row"><span><strong>响度均衡</strong><small>按歌曲自带的响度信息（QQ 音乐、本地文件的 ReplayGain）统一音量，避免忽大忽小。</small></span><input type="checkbox" class="toggle" id="normalize-toggle" ${s.normalize ? "checked" : ""}/></label></section>
${o.desktop ? `<section><h3>均衡器</h3><div class="chip-grid" role="group" aria-label="均衡器预设">${presets}</div></section>` : ""}
<section><h3>切歌淡入淡出 <output id="crossfade-value">${s.crossfade ? `${s.crossfade} 秒` : "关闭"}</output></h3><input id="crossfade" type="range" min="0" max="12" step="1" value="${s.crossfade}" aria-label="淡入淡出时长"/><small class="summary">上一首渐弱时下一首渐强；单曲循环时不生效。</small></section>
<section><h3>睡眠定时 <output id="sleep-state">${sleepLabel()}</output></h3><div class="chip-grid" role="group" aria-label="睡眠定时">${sleeps
      .map(
        ([key, label]) =>
          `<button data-sleep="${key}" aria-pressed="${key === active}">${label}</button>`,
      )
      .join("")}</div></section>`;
    const range = dialog.querySelector<HTMLInputElement>("#crossfade")!;
    range.style.setProperty("--fill", `${(s.crossfade / 12) * 100}%`);
  }
  function setSleep(value: string) {
    clearTimeout(sleepTimer);
    clearInterval(tick);
    if (value === "off") sleep = { mode: "off" };
    else if (value === "track") sleep = { mode: "track" };
    else {
      const minutes = Number(value);
      sleep = { mode: "time", endsAt: Date.now() + minutes * 60000 };
      sleepTimer = window.setTimeout(expire, minutes * 60000);
      tick = window.setInterval(render, 30000);
    }
    render();
    if (sleep.mode !== "off") o.toast(`睡眠定时：${sleepLabel()}`);
  }
  function expire() {
    clearInterval(tick);
    // A slow fade, then pause: waking to a sudden stop is worse than none.
    o.sound.fadeOut(8, () => {
      o.audio.pause();
      o.sound.resetFade();
    });
    sleep = { mode: "off" };
    render();
  }
  dialog.addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    if (el.closest("[data-sound-close]")) return closeDialog(dialog);
    const eq = el.closest<HTMLElement>("[data-eq]");
    if (eq) {
      if (o.sound.setPreset(eq.dataset.eq!)) o.reload();
      render();
      return;
    }
    const s = el.closest<HTMLElement>("[data-sleep]");
    if (s) setSleep(s.dataset.sleep!);
  });
  dialog.addEventListener("change", (e) => {
    const el = e.target as HTMLInputElement;
    if (el.id === "normalize-toggle") {
      o.sound.setNormalize(el.checked, o.currentGain());
      renderButton();
    }
  });
  dialog.addEventListener("input", (e) => {
    const el = e.target as HTMLInputElement;
    if (el.id !== "crossfade") return;
    o.sound.setCrossfade(Number(el.value));
    el.style.setProperty("--fill", `${(Number(el.value) / 12) * 100}%`);
    dialog.querySelector("#crossfade-value")!.textContent = Number(el.value)
      ? `${el.value} 秒`
      : "关闭";
    renderButton();
  });
  const open = () => {
    openDialog(dialog);
    render();
    animateContent(dialog, { distance: 5 });
  };
  button.onclick = open;
  renderButton();
  return {
    open,
    /** True once when a "stop after this song" timer should end playback. */
    stopAtTrackEnd() {
      if (sleep.mode !== "track") return false;
      sleep = { mode: "off" };
      render();
      return true;
    },
    get armedForTrackEnd() {
      return sleep.mode === "track";
    },
  };
}
