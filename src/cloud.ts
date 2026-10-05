import { invoke } from "@tauri-apps/api/core";
import type { Source } from "./library";

export type Playback = {
  url: string;
  trial: boolean;
  trialStart: number;
  bitrate: number;
  level: string;
  requestedLevel: string;
  format: string;
};
export const qualityNames: Record<string, string> = {
  standard: "标准",
  exhigh: "高品质",
  lossless: "无损",
  best: "最高可用",
};
export const actualQualityNames: Record<string, string> = {
  ...qualityNames,
  higher: "较高",
  hires: "Hi-Res",
  jymaster: "超清母带",
  master: "臻品母带",
  jyeffect: "高清环绕",
  sky: "沉浸环绕",
};
export async function cloud<T>(
  command: string,
  args: Record<string, unknown> = {},
  source: Source = "netease",
): Promise<T> {
  if (source === "qq")
    return invoke<T>("qq_request", { operation: command, args });
  const request = { ...args };
  if (command === "song_url" && request.level === "best") {
    let trial: T | undefined, lastError: unknown;
    for (const level of [
      "jymaster",
      "hires",
      "lossless",
      "exhigh",
      "standard",
    ]) {
      try {
        const result = await invoke<Playback>(command, { ...request, level });
        if (!result.trial) return result as T;
        trial = result as T;
      } catch (e) {
        lastError = e;
      }
    }
    if (trial) return trial;
    throw lastError || new Error("没有可用音源");
  }
  return invoke<T>(command, request);
}
