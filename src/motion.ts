import "./motion.css";

const ease = "cubic-bezier(.22, 1, .36, 1)";
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
): Animation | undefined {
  if (preference.matches || typeof element.animate !== "function") {
    finished();
    return;
  }
  const animation = element.animate(frames, { duration, easing: ease });
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
  if (preference.matches) for (const animation of active) animation.finish();
});

export function animateContent(
  element: HTMLElement | SVGElement,
  options: { distance?: number; duration?: number } = {},
): void {
  const previous = content.get(element);
  const current = previous ? getComputedStyle(element) : undefined;
  const startOpacity = current?.opacity ?? "0.88";
  const startTransform = current?.transform;
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
  const animation = run(
    element,
    [
      {
        opacity: startOpacity,
        transform:
          startTransform ??
          `${transform}translate3d(0, ${options.distance ?? 8}px, 0)`,
      },
      { opacity: 1, transform: base },
    ],
    options.duration ?? 220,
    () => {
      if (content.get(element) === animation) content.delete(element);
    },
  );
  if (animation) content.set(element, animation);
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

function hiddenDialogTransform() {
  return document.documentElement.classList.contains("mobile-device")
    ? "translate3d(0, 22px, 0)"
    : "translate3d(0, 9px, 0) scale(.98)";
}

export function openDialog(dialog: HTMLDialogElement): void {
  const state = stateFor(dialog);
  if (dialog.open && !state.closing) return;
  const current = dialog.open ? getComputedStyle(dialog) : undefined;
  const opacity = current?.opacity ?? "0";
  const transform = current?.transform ?? hiddenDialogTransform();
  stop(state.animation);
  state.animation = undefined;
  state.closing = false;
  // showModal/close still own top-layer, focus trapping and focus restoration.
  if (!dialog.open) dialog.showModal();
  dialog.dataset.motion = "open";
  state.animation = run(
    dialog,
    [
      { opacity, transform },
      { opacity: 1, transform: "none" },
    ],
    240,
    () => {
      state.animation = undefined;
    },
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
      { opacity: 0, transform: hiddenDialogTransform() },
    ],
    150,
    () => {
      state.animation = undefined;
      state.closing = false;
      delete dialog.dataset.motion;
      dialog.close();
    },
  );
}
