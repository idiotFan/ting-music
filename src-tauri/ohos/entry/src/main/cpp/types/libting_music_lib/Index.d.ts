// Rust N-API exports of the Ting native module (src-tauri/src/ohos_bridge.rs).
export const bootstrap: (info: string) => void;
export const registerDispatcher: (callback: (action: string, payload: string) => string) => void;
export const mediaCommand: (action: string, seekTime?: number) => void;
