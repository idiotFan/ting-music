/** Decode the next album cover before replacing the currently visible image. */
export function createCover(
  container: HTMLElement,
  fallback: () => HTMLElement,
) {
  let requested: string | undefined;
  let generation = 0;
  let pending: (() => void) | undefined;
  let finishFade: (() => void) | undefined;
  let queued: HTMLElement | undefined;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  reduced.addEventListener("change", () => {
    if (reduced.matches) finishFade?.();
  });
  function swap(next: HTMLElement) {
    // Finish the visible blend naturally. Keep only the newest decoded image
    // waiting behind it, so quick cached changes cannot snap the middle cover.
    if (finishFade) {
      queued = next;
      return;
    }
    const previous = container.firstElementChild;
    container.append(next);
    if (!previous || reduced.matches || typeof next.animate !== "function") {
      previous?.remove();
      return;
    }
    const animation = next.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 240,
      easing: "ease-out",
    });
    const finish = () => {
      animation.onfinish = null;
      animation.cancel();
      previous.remove();
      if (finishFade === finish) finishFade = undefined;
      const nextReady = queued;
      queued = undefined;
      if (nextReady) swap(nextReady);
    };
    finishFade = finish;
    animation.onfinish = finish;
  }
  return (src: string, alt: string) => {
    if (src === requested) {
      container.querySelectorAll("img").forEach((image) => (image.alt = alt));
      return;
    }
    requested = src;
    const serial = ++generation;
    queued = undefined;
    pending?.();
    pending = undefined;
    if (!src) {
      swap(fallback());
      return;
    }
    const image = new Image();
    image.alt = alt;
    image.referrerPolicy = "no-referrer";
    image.decoding = "async";
    const timeout = window.setTimeout(() => settle(false), 10000);
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      image.onload = image.onerror = null;
    };
    const settle = async (loaded: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (loaded) {
        try {
          await image.decode();
        } catch {
          loaded = image.naturalWidth > 0;
        }
      }
      if (serial !== generation) return;
      pending = undefined;
      if (!loaded) requested = undefined;
      swap(loaded ? image : fallback());
    };
    pending = () => {
      settled = true;
      cleanup();
      image.removeAttribute("src");
    };
    image.onload = () => void settle(true);
    image.onerror = () => void settle(false);
    image.src = src;
  };
}
