// Left-edge swipe-to-go-back for touch devices. iOS webviews have no system
// back gesture, so the playlist detail view mirrors its back button here.
// Android reaches the same button through MainActivity's back-key bridge.

import { MOTION, animateOut } from "./motion";

const EDGE_WIDTH = 24; // px from the left viewport edge that can start a swipe
const ACTIVATION = 10; // px of horizontal travel before owning the touch
const DOMINANCE = 2; // horizontal must outweigh vertical by this factor
const COMMIT = 72; // px of travel that triggers the navigation
const RELEASE = 48; // px the committed content keeps travelling on its own
const RELEASE_LIMIT = 0.32; // share of the viewport that travel may not exceed

type Phase = "watching" | "dragging" | "cancelled";

export function setupBackGesture(active: () => boolean, back: () => void) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let phase: Phase | null = null;
  let identifier = -1;
  let settleTimer = 0;
  let committing = false;
  let startX = 0,
    startY = 0;

  const sheet = () => document.querySelector<HTMLElement>(".library");
  const blocked = () =>
    committing ||
    !active() ||
    !!document.querySelector("dialog[open]") ||
    !document.querySelector<HTMLElement>("#lyrics-panel")?.hidden;

  function tracked(event: TouchEvent): Touch | undefined {
    for (const touch of Array.from(event.changedTouches))
      if (touch.identifier === identifier) return touch;
    return undefined;
  }

  function follow(dx: number) {
    // Rubber-band the content with the finger; reduced motion skips feedback.
    if (reduced.matches) return;
    const el = sheet();
    if (el) el.style.transform = dx > 0 ? `translateX(${dx}px)` : "";
  }

  // Below the threshold the promise is withdrawn: the page returns to rest.
  function cancelSwipe() {
    const el = sheet();
    phase = null;
    identifier = -1;
    if (!el || !el.style.transform) return;
    // Back-to-back gestures used to leave the class behind, which made the
    // next drag transition instead of tracking the finger.
    window.clearTimeout(settleTimer);
    el.classList.add("back-swipe-settle");
    el.style.transform = "";
    settleTimer = window.setTimeout(
      () => el.classList.remove("back-swipe-settle"),
      220,
    );
  }

  // Past the threshold the finger's promise is kept: this page finishes its
  // exit to the right, and only then does the previous layer come in.
  function commitSwipe(dx: number) {
    const el = sheet();
    phase = null;
    identifier = -1;
    if (!el || reduced.matches) {
      el?.style.removeProperty("transform");
      back();
      return;
    }
    window.clearTimeout(settleTimer);
    // The settle transition and the exit animation would otherwise drive the
    // same property at once.
    el.classList.remove("back-swipe-settle");
    committing = true;
    const target = Math.min(dx + RELEASE, window.innerWidth * RELEASE_LIMIT);
    void animateOut(
      el,
      { transform: `translate3d(${target}px, 0, 0)`, opacity: 0 },
      { duration: MOTION.t2, easing: MOTION.exit },
    ).then(() => {
      el.style.removeProperty("transform");
      el.style.removeProperty("opacity");
      committing = false;
      back();
    });
  }

  document.addEventListener(
    "touchstart",
    (event) => {
      if (phase || event.touches.length !== 1 || blocked()) return;
      const touch = event.touches[0];
      if (touch.clientX > EDGE_WIDTH) return;
      phase = "watching";
      identifier = touch.identifier;
      startX = touch.clientX;
      startY = touch.clientY;
    },
    { passive: true },
  );

  document.addEventListener(
    "touchmove",
    (event) => {
      if (!phase || phase === "cancelled") return;
      const touch = tracked(event);
      if (!touch) return;
      const dx = touch.clientX - startX,
        dy = touch.clientY - startY;
      if (phase === "watching") {
        // Vertical intent hands the touch back to normal scrolling.
        if (Math.abs(dy) > Math.abs(dx) || dx < -ACTIVATION) {
          phase = "cancelled";
          return;
        }
        if (dx > ACTIVATION && dx > Math.abs(dy) * DOMINANCE)
          phase = "dragging";
        else return;
      }
      // Owning the gesture: keep the list from scrolling under the finger.
      event.preventDefault();
      follow(dx);
    },
    { passive: false },
  );

  const finish = (commit: boolean) => (event: TouchEvent) => {
    if (!phase) return;
    const touch = tracked(event);
    if (!touch) return;
    const dx = touch.clientX - startX;
    const threshold = Math.min(COMMIT, window.innerWidth / 4);
    const triggered =
      phase === "dragging" && commit && !blocked() && dx > threshold;
    if (triggered) commitSwipe(dx);
    else cancelSwipe();
  };
  document.addEventListener("touchend", finish(true), { passive: true });
  document.addEventListener("touchcancel", finish(false), { passive: true });
}
