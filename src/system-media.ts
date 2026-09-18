import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createNativeSession } from "./native-media-session.mjs";

export async function systemMediaBackend() {
  if (isTauri()) {
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
      if (!["apple", "windows", "mpris"].includes(backend))
        throw Error("unsupported");
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
      window.dispatchEvent(new Event("system-media-error"));
    }
  }
  return {
    session: navigator.mediaSession,
    metadata: (value: MediaMetadataInit) => new MediaMetadata(value),
  };
}
