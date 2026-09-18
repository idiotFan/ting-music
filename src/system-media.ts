import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { platform } from "./platform";
import { createNativeSession } from "./native-media-session.mjs";

export async function systemMediaBackend() {
  let degraded = false;
  // WKWebView owns the actual HTMLAudioElement session in its media process.
  // Publishing a second MPNowPlayingInfoCenter in the host cannot take it over.
  // Keep Apple metadata and commands on that real audio session.
  if (isTauri() && !platform.ios && !platform.mac && !platform.android) {
    let unlisten: (() => void) | undefined;
    const session = createNativeSession({
      update: (snapshot: unknown) =>
        invoke("system_media_update", { snapshot }),
      onError: () => window.dispatchEvent(new Event("system-media-error")),
    });
    try {
      unlisten = await listen("system-media-action", (event) =>
        session.dispatch(event.payload),
      );
      const backend = await invoke<string>("system_media_init");
      if (!["windows", "mpris"].includes(backend)) throw Error("unsupported");
      // Do not register web actions as well: two owners can hide buttons or
      // dispatch the same media key twice. Browser previews retain the web API.
      if (navigator.mediaSession) {
        for (const action of [
          "play",
          "pause",
          "previoustrack",
          "nexttrack",
          "seekto",
          "seekbackward",
          "seekforward",
        ] as MediaSessionAction[]) {
          try {
            navigator.mediaSession.setActionHandler(action, null);
          } catch {
            /* optional */
          }
        }
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = "none";
      }
      window.addEventListener(
        "pagehide",
        () => {
          unlisten?.();
          session.dispose();
        },
        { once: true },
      );
      return { session, metadata: (value: MediaMetadataInit) => value };
    } catch {
      unlisten?.();
      session.dispose();
      degraded = true;
    }
  }
  return {
    degraded,
    session: navigator.mediaSession,
    metadata: (value: MediaMetadataInit) => new MediaMetadata(value),
  };
}
