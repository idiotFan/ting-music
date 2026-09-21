import { invoke, isTauri } from "@tauri-apps/api/core";
import { mobileDevice } from "./platform";
import { MOTION } from "./motion";
import "./lyrics-motion.css";
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
    manual = false;
  const motionPreference = matchMedia("(prefers-reduced-motion: reduce)");
  const reduced = () => motionPreference.matches;
  function center(instant = false) {
    cancelAnimationFrame(frame);
    if (panel.hidden || manual) return;
    const line = box.querySelector<HTMLElement>(`[data-line="${index}"]`);
    if (!line) return;
    const target = Math.min(
        Math.max(0, box.scrollHeight - box.clientHeight),
        Math.max(
          0,
          line.offsetTop - (box.clientHeight - line.offsetHeight) / 2,
        ),
      ),
      from = box.scrollTop;
    if (instant || reduced() || Math.abs(target - from) < 1) {
      box.scrollTop = target;
      return;
    }
    const started = performance.now(),
      duration = Math.min(540, Math.max(280, Math.abs(target - from) * 0.7));
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
  const nativeDesktop = isTauri() && !mobileDevice;
  let nativeExpanded = false,
    nativeResize = Promise.resolve(),
    lockedLayout: { flex: string; margin: string } | undefined;

  function resizeDesktop(open: boolean) {
    if (!nativeDesktop) return Promise.resolve();
    // Opening/closing can be reversed while the native window is resizing.
    // Serialize those requests so the final window and the final sheet agree.
    nativeResize = nativeResize
      .catch(() => {})
      .then(async () => {
        if (nativeExpanded === open) return;
        await invoke("set_lyrics_panel", { open });
        nativeExpanded = open;
      });
    return nativeResize;
  }
  function lockPlayerWidth() {
    if (!nativeDesktop || lockedLayout) return;
    const bounds = app.getBoundingClientRect();
    lockedLayout = { flex: app.style.flex, margin: app.style.margin };
    app.style.flex = `0 0 ${bounds.width}px`;
    // Auto margins would recenter the player in the newly-expanded window
    // for one frame before the lyrics pane becomes visible.
    app.style.margin = `0 0 0 ${bounds.left}px`;
  }
  function releasePlayerWidth() {
    if (!lockedLayout) return;
    app.style.flex = lockedLayout.flex;
    app.style.margin = lockedLayout.margin;
    lockedLayout = undefined;
  }
  function visibility(open: boolean) {
    panel.hidden = box.hidden = !open;
    document.body.classList.toggle("lyrics-open", open);
    if (mobileDevice) app.inert = open;
  }
  function clearPanelMotion() {
    sheetAnimation?.cancel();
    sheetAnimation = undefined;
    panel.style.removeProperty("opacity");
    panel.style.removeProperty("transform");
  }
  // The panel is anchored to the right edge at every width, so it arrives and
  // leaves on the X axis. How far it travels is a layout fact: a fixed drawer
  // clears its own width, while the desktop column only slides a hand's width
  // into the space the native window just made.
  const offset = () =>
    getComputedStyle(panel).getPropertyValue("--lyrics-enter").trim() || "28px";
  async function setOpen(open: boolean) {
    if (open === opened) return;
    const serial = ++transition;
    opened = open;
    const wasVisible = !panel.hidden;
    const previous = getComputedStyle(panel);
    const from = {
      opacity: wasVisible ? previous.opacity : "0",
      transform:
        wasVisible && previous.transform !== "none"
          ? previous.transform
          : "none",
    };
    // Preserve the currently painted frame before cancelling a reversed motion.
    // Otherwise cancellation briefly paints the fully-open panel on WebKit.
    sheetAnimation?.cancel();
    sheetAnimation = undefined;
    if (wasVisible) {
      panel.style.opacity = from.opacity;
      panel.style.transform = from.transform;
    }
    lockPlayerWidth();
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "隐藏歌词" : "显示歌词");
    try {
      if (open) {
        await resizeDesktop(true);
        if (serial !== transition) return;
        visibility(true);
        if (mobileDevice) close.focus({ preventScroll: true });
        center(true);
      }
      // Read the travel once the open state is settled: the drawer only knows
      // how wide it is after `lyrics-open` has applied.
      const hidden = `translate3d(${offset()}, 0, 0)`;
      if (!wasVisible) from.transform = hidden;
      const destination = {
        opacity: open ? "1" : "0",
        transform: open ? "none" : hidden,
      };
      if (!panel.hidden && !reduced()) {
        const animation = panel.animate([from, destination], {
          duration: open ? MOTION.t4 : MOTION.t2,
          easing: open ? MOTION.enter : MOTION.exit,
          fill: "both",
        });
        sheetAnimation = animation;
        await animation.finished.catch(() => {});
      }
      if (serial !== transition) return;
      if (!open) {
        // Fade the pane away before shrinking the native window. Keep the
        // player's width fixed until the native resize has finished.
        visibility(false);
        await resizeDesktop(false);
        if (serial !== transition) return;
        if (mobileDevice) toggle.focus({ preventScroll: true });
      }
    } catch (e) {
      if (serial !== transition) return;
      opened = nativeDesktop ? nativeExpanded : wasVisible;
      visibility(opened);
      toggle.setAttribute("aria-expanded", String(opened));
      toggle.setAttribute("aria-label", opened ? "隐藏歌词" : "显示歌词");
      onError(`无法调整歌词窗口：${String(e)}`);
    } finally {
      // Every early return leaves through here, so a filled animation can
      // never strand the panel off screen with inline styles.
      if (serial === transition) {
        releasePlayerWidth();
        clearPanelMotion();
      }
    }
  }
  motionPreference.addEventListener("change", () => {
    if (!reduced()) return;
    sheetAnimation?.finish();
    center(true);
  });
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
