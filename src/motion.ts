import "./motion.css";

// Mirror of the :root tokens in motion.css. Both sides must stay identical:
// CSS transitions and WAAPI animations describe the same spatial model.
export const MOTION = {
  t1: 120,
  t2: 180,
  t3: 240,
  t4: 300,
  t5: 420,
  enter: "cubic-bezier(.22, 1, .36, 1)",
  exit: "cubic-bezier(.4, 0, 1, 1)",
  move: "cubic-bezier(.32, .72, 0, 1)",
  breath: "cubic-bezier(.37, 0, .63, 1)",
  dMicro: 4,
  dArrive: 6,
  dLateral: 16,
  dPush: 28,
  staggerStep: 22,
  staggerMax: 8,
} as const;

const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
const active = new Set<Animation>();
const content = new WeakMap<HTMLElement | SVGElement, Animation>();
type DialogMotion = {
  animation?: Animation;
  closing: boolean;
};
const dialogs = new WeakMap<HTMLDialogElement, DialogMotion>();

function stop(animation?: Animation) {
  if (!animation) return;
  active.delete(animation);
  animation.onfinish = null;
  animation.oncancel = null;
  animation.cancel();
}

// Only running animations are retained. Finishing removes the effect too, so
// later CSS changes and repeated navigation never inherit a frozen transform.
function run(
  element: HTMLElement | SVGElement,
  frames: Keyframe[],
  duration: number,
  finished: () => void,
  easing: string = MOTION.enter,
  delay = 0,
): Animation | undefined {
  if (preference.matches || typeof element.animate !== "function") {
    finished();
    return;
  }
  const animation = element.animate(frames, {
    duration,
    easing,
    delay,
    // A delayed entrance must already hold its first frame, otherwise the
    // element paints at rest and only then jumps back to the start.
    fill: delay > 0 ? "backwards" : "none",
  });
  active.add(animation);
  animation.onfinish = () => {
    active.delete(animation);
    finished();
    stop(animation);
  };
  animation.oncancel = () => active.delete(animation);
  return animation;
}

preference.addEventListener("change", () => {
  if (!preference.matches) return;
  // Infinite animations reject finish(); they settle through their own owner.
  for (const animation of [...active])
    if (animation.effect?.getComputedTiming().iterations !== Infinity)
      animation.finish();
});

export type ContentMotion = {
  /** Travel in px along `axis`; 0 keeps the element in place. */
  distance?: number;
  duration?: number;
  axis?: "x" | "y";
  direction?: -1 | 0 | 1;
  /** Starting opacity. Ignored while interrupting: continuity wins. */
  from?: number | string;
  easing?: string;
  delay?: number;
  /** Optional origin scale for an in-place swap such as an icon. */
  scaleFrom?: number;
};

export function animateContent(
  element: HTMLElement | SVGElement,
  options: ContentMotion = {},
): void {
  // Only an animation still in flight hands over its current frame; one that
  // has finished but not yet dropped out of the map must not start the next
  // entrance from the resting transform and lose its direction.
  const previous = content.get(element);
  const current =
    previous && previous.playState === "running"
      ? getComputedStyle(element)
      : undefined;
  // Read the live values before cancelling, so a reversal continues from the
  // painted frame instead of snapping back to a nominal start.
  const liveOpacity = current?.opacity;
  const liveTransform = current?.transform;
  stop(previous);
  content.delete(element);
  if (
    !element.isConnected ||
    preference.matches ||
    typeof element.animate !== "function"
  )
    return;
  const base = getComputedStyle(element).transform;
  const transform = base === "none" ? "" : `${base} `;
  const distance = options.distance ?? 8;
  const direction = options.direction ?? 1;
  const offset = direction * distance;
  const origin =
    options.scaleFrom !== undefined
      ? `${transform}scale(${options.scaleFrom})`
      : distance === 0
        ? // A pure cross-fade must not write a transform at all: an empty
          // string would land as `none` on an element that already has one.
          undefined
        : options.axis === "x"
          ? `${transform}translate3d(${offset}px, 0, 0)`
          : `${transform}translate3d(0, ${offset}px, 0)`;
  const startTransform = liveTransform ?? origin;
  const start: Keyframe = { opacity: liveOpacity ?? options.from ?? "0.88" };
  const end: Keyframe = { opacity: 1 };
  if (startTransform !== undefined) {
    start.transform = startTransform;
    end.transform = base;
  }
  const animation = run(
    element,
    [start, end],
    options.duration ?? 220,
    () => {
      if (content.get(element) === animation) content.delete(element);
    },
    options.easing,
    options.delay,
  );
  if (animation) content.set(element, animation);
}

/** Leave from the painted frame towards an explicit resting point. */
export function animateOut(
  element: HTMLElement,
  to: { transform?: string; opacity?: number },
  options: { duration?: number; easing?: string } = {},
): Promise<void> {
  stop(content.get(element));
  content.delete(element);
  if (
    !element.isConnected ||
    preference.matches ||
    typeof element.animate !== "function"
  )
    return Promise.resolve();
  const current = getComputedStyle(element);
  const start: Keyframe = {
    opacity: current.opacity,
    transform: current.transform,
  };
  return new Promise<void>((resolve) => {
    const animation = run(
      element,
      [start, { opacity: to.opacity ?? 0, transform: to.transform ?? "none" }],
      options.duration ?? MOTION.t2,
      () => {
        if (content.get(element) === animation) content.delete(element);
        resolve();
      },
      options.easing ?? MOTION.exit,
    );
    if (!animation) {
      resolve();
      return;
    }
    content.set(element, animation);
    // stop() clears oncancel, so listen instead: an interrupted exit must
    // still release its caller rather than leaving the promise pending.
    animation.addEventListener("cancel", () => resolve());
  });
}

/** Stagger a bounded head of freshly inserted rows into place. */
export function animateArrival(
  rows: HTMLElement[],
  options: {
    distance?: number;
    duration?: number;
    step?: number;
    max?: number;
  } = {},
): void {
  const distance = options.distance ?? MOTION.dArrive;
  const duration = options.duration ?? MOTION.t3;
  const step = options.step ?? MOTION.staggerStep;
  rows.slice(0, options.max ?? MOTION.staggerMax).forEach((row, index) => {
    run(
      row,
      [
        { opacity: 0, transform: `translate3d(0, ${distance}px, 0)` },
        { opacity: 1, transform: "none" },
      ],
      duration,
      () => {},
      MOTION.enter,
      index * step,
    );
  });
}

function stateFor(dialog: HTMLDialogElement): DialogMotion {
  let state = dialogs.get(dialog);
  if (state) return state;
  state = { closing: false };
  dialogs.set(dialog, state);
  dialog.addEventListener("focusin", (event) => {
    // Keyboard avoidance owns the sheet geometry as soon as editing starts.
    // Settle the entrance before its transform can push a field below the IME.
    if (
      document.documentElement.classList.contains("mobile-device") &&
      event.target instanceof HTMLElement &&
      event.target.matches(
        'input:not([type="range"]), textarea, [contenteditable="true"]',
      ) &&
      !state!.closing
    ) {
      for (const animation of dialog.getAnimations({ subtree: true })) {
        if (animation.effect?.getComputedTiming().iterations !== Infinity)
          animation.finish();
      }
    }
  });
  // Existing cancel handlers run first. They retain ownership of busy guards,
  // while unhandled Escape uses the same transition as the close button.
  dialog.addEventListener("cancel", (event) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    closeDialog(dialog);
  });
  dialog.addEventListener("close", () => {
    // A native close event can arrive after the dialog has already reopened.
    if (dialog.open) return;
    stop(state!.animation);
    state!.animation = undefined;
    state!.closing = false;
    delete dialog.dataset.motion;
  });
  return state;
}

// A phone sheet is anchored to the bottom edge and can be half a screen tall,
// so it travels its own height; overshoot is forbidden, since crossing zero
// would expose a strip of the page behind it. A desktop dialog floats instead:
// scale leads and the offset only supports it.
function hiddenDialogTransform() {
  return document.documentElement.classList.contains("mobile-device")
    ? "translate3d(0, 100%, 0)"
    : "translate3d(0, 10px, 0) scale(.965)";
}

/** A full-screen page on a phone arrives opaque, the way iOS presents one:
 *  fading it would show the screen beneath flashing through. */
const opaquePage = (dialog: HTMLDialogElement) =>
  dialog.dataset.presentation === "page" &&
  document.documentElement.classList.contains("mobile-device");

export function openDialog(dialog: HTMLDialogElement): void {
  const state = stateFor(dialog);
  if (dialog.open && !state.closing) return;
  const current = dialog.open ? getComputedStyle(dialog) : undefined;
  const opacity = opaquePage(dialog) ? "1" : (current?.opacity ?? "0");
  const transform = current?.transform ?? hiddenDialogTransform();
  stop(state.animation);
  state.animation = undefined;
  state.closing = false;
  // showModal/close still own top-layer, focus trapping and focus restoration.
  if (!dialog.open) {
    dialog.showModal();
    // A touch screen has no keyboard focus to show: WebKit would ring the
    // first button (the sheet's close / Done) as if tabbed to. Hold focus on
    // the sheet itself; Tab still walks its controls in order.
    if (document.documentElement.classList.contains("mobile-device")) {
      dialog.tabIndex = -1;
      dialog.focus({ preventScroll: true });
    }
  }
  dialog.dataset.motion = "open";
  state.animation = run(
    dialog,
    [
      { opacity, transform },
      { opacity: 1, transform: "none" },
    ],
    MOTION.t4,
    () => {
      state.animation = undefined;
    },
    MOTION.enter,
  );
}

export function closeDialog(dialog: HTMLDialogElement): void {
  const state = stateFor(dialog);
  if (!dialog.open || state.closing) return;
  const current = getComputedStyle(dialog);
  // Capture values before cancellation; getComputedStyle itself is live.
  const opacity = current.opacity;
  const transform = current.transform;
  stop(state.animation);
  state.animation = undefined;
  state.closing = true;
  dialog.dataset.motion = "closing";
  state.animation = run(
    dialog,
    [
      { opacity, transform },
      {
        opacity: opaquePage(dialog) ? 1 : 0,
        transform: hiddenDialogTransform(),
      },
    ],
    // A whole screen needs a little longer to leave than a small sheet.
    opaquePage(dialog) ? MOTION.t3 : MOTION.t2,
    () => {
      state.animation = undefined;
      state.closing = false;
      delete dialog.dataset.motion;
      dialog.close();
    },
    MOTION.exit,
  );
}
