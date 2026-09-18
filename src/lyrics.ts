import { invoke, isTauri } from "@tauri-apps/api/core";
import { mobileDevice } from "./platform";
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
  let opened = false,
    transition = 0,
    sheetAnimation: Animation | undefined;
  const app = document.querySelector<HTMLElement>("#app")!;
  async function setOpen(open: boolean) {
    if ((!mobileDevice && resizing) || open === opened) return;
    const serial = ++transition;
    opened = open;
    const previousOpacity = getComputedStyle(panel).opacity;
    const previousTransform = getComputedStyle(panel).transform;
    const wasVisible = !panel.hidden;
    sheetAnimation?.cancel();
    resizing = true;
    if (!mobileDevice) toggle.disabled = close.disabled = true;
    try {
      if (isTauri() && !mobileDevice)
        await invoke("set_lyrics_panel", { open });
      if (open) {
        panel.hidden = box.hidden = false;
        document.body.classList.add("lyrics-open");
        if (mobileDevice) {
          app.inert = true;
          close.focus({ preventScroll: true });
        }
        requestAnimationFrame(() => center(true));
      }
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "隐藏歌词" : "显示歌词");
      if (mobileDevice && !reduced()) {
        const resting = { opacity: 1, transform: "translateY(0)" };
        const outside = { opacity: 0, transform: "translateY(36px)" };
        sheetAnimation = panel.animate(
          [
            wasVisible
              ? { opacity: previousOpacity, transform: previousTransform }
              : outside,
            open ? resting : outside,
          ],
          {
            duration: open ? 300 : 220,
            easing: "cubic-bezier(0.22, 1, 0.36, 1)",
            fill: "both",
          },
        );
        await sheetAnimation.finished.catch(() => {});
      }
      if (serial !== transition) return;
      sheetAnimation?.cancel();
      sheetAnimation = undefined;
      if (!open) {
        panel.hidden = box.hidden = true;
        document.body.classList.remove("lyrics-open");
        app.inert = false;
        if (mobileDevice) toggle.focus({ preventScroll: true });
      }
    } catch (e) {
      opened = !panel.hidden;
      onError(`无法调整歌词窗口：${String(e)}`);
    } finally {
      if (serial === transition) {
        resizing = false;
        toggle.disabled = close.disabled = false;
      }
    }
  }
  toggle.onclick = () => void setOpen(!opened);
  close.onclick = () => void setOpen(false);
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      void setOpen(false);
    }
  });
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
