import { invoke, isTauri } from "@tauri-apps/api/core";
export function setupLyrics(
  audio: HTMLAudioElement,
  seek: (index: number) => void,
  onError: (message: string) => void,
) {
  const panel = document.querySelector<HTMLElement>("#lyrics-panel")!,
    box = document.querySelector<HTMLElement>("#lyrics")!;
  const toggle = document.querySelector<HTMLButtonElement>("#lyrics-toggle")!,
    close = document.querySelector<HTMLButtonElement>("#lyrics-close")!,
    follow = document.querySelector<HTMLButtonElement>("#lyrics-follow")!;
  let index = -1,
    frame = 0,
    manual = false,
    resizing = false;
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  function center(instant = false) {
    cancelAnimationFrame(frame);
    if (panel.hidden || manual) return;
    const line = box.querySelector<HTMLElement>(`[data-line="${index}"]`);
    if (!line) return;
    const target = Math.max(
        0,
        line.offsetTop - (box.clientHeight - line.offsetHeight) / 2,
      ),
      from = box.scrollTop;
    if (instant || reduced() || Math.abs(target - from) < 1) {
      box.scrollTop = target;
      return;
    }
    const started = performance.now(),
      duration = 460;
    function tick(now: number) {
      const t = Math.min(1, (now - started) / duration);
      box.scrollTop = from + (target - from) * (1 - Math.pow(1 - t, 3));
      if (t < 1) frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
  }
  function sync(next: number, instant = false, force = false) {
    if (next === index && !force) return;
    index = next;
    box.querySelectorAll<HTMLElement>("[data-line]").forEach((line, i) => {
      line.classList.toggle("current", i === index);
      line.classList.toggle("near", Math.abs(i - index) === 1);
      line.classList.toggle("past", i < index);
      line.setAttribute("aria-current", String(i === index));
    });
    center(instant);
  }
  async function setOpen(open: boolean) {
    if (resizing || open === !panel.hidden) return;
    resizing = true;
    toggle.disabled = close.disabled = true;
    try {
      if (isTauri()) await invoke("set_lyrics_panel", { open });
      panel.hidden = box.hidden = !open;
      document.body.classList.toggle("lyrics-open", open);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "隐藏歌词" : "显示歌词");
      if (open) requestAnimationFrame(() => center(true));
    } catch (e) {
      onError(`无法调整歌词窗口：${String(e)}`);
    } finally {
      resizing = false;
      toggle.disabled = close.disabled = false;
    }
  }
  toggle.onclick = () => void setOpen(panel.hidden);
  close.onclick = () => void setOpen(false);
  function browse() {
    manual = true;
    cancelAnimationFrame(frame);
    follow.hidden = false;
  }
  box.addEventListener("wheel", browse, { passive: true });
  box.addEventListener("touchstart", browse, { passive: true });
  box.addEventListener("keydown", (e) => {
    if (
      ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(
        e.key,
      )
    )
      browse();
  });
  follow.onclick = () => {
    manual = false;
    follow.hidden = true;
    center();
  };
  box.addEventListener("click", (e) => {
    const line = (e.target as HTMLElement).closest<HTMLElement>("[data-line]");
    if (!line || !Number.isFinite(audio.duration)) return;
    manual = false;
    follow.hidden = true;
    seek(Number(line.dataset.line));
  });
  const observer = new ResizeObserver(() => {
    box.style.setProperty(
      "--lyric-space",
      `${Math.max(16, box.clientHeight / 2 - 18)}px`,
    );
    center(true);
  });
  observer.observe(box);
  return {
    sync,
    resume: (next: number, instant = false) => {
      manual = false;
      follow.hidden = true;
      sync(next, instant, true);
    },
    reset: () => {
      cancelAnimationFrame(frame);
      index = -1;
      manual = false;
      follow.hidden = true;
      box.scrollTop = 0;
    },
  };
}
