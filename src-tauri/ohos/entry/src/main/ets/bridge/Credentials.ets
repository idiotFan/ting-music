import { asset } from '@kit.AssetStoreKit';
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError } from '@kit.BasicServicesKit';

const DOMAIN = 0x0000;
// One alias per account, mirroring the Keychain/Keystore records on other platforms.
const ACCOUNTS: string[] = ['netease-session', 'qq-session'];
const PREFIX = 'com.ting.music.demo:';

function bytes(text: string): Uint8Array {
  return new util.TextEncoder().encodeInto(text);
}

function text(data: Uint8Array): string {
  return util.TextDecoder.create('utf-8').decodeToString(data);
}

function aliasOf(account: string): Uint8Array {
  return bytes(PREFIX + account);
}

/** Synchronous so the sessions are in place before Tauri's setup runs. */
export function loadCredentials(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const account of ACCOUNTS) {
    try {
      const query: asset.AssetMap = new Map();
      query.set(asset.Tag.ALIAS, aliasOf(account));
      query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
      const found = asset.querySync(query);
      const secret = found.length > 0 ? found[0].get(asset.Tag.SECRET) as Uint8Array : undefined;
      if (secret) {
        result[account] = text(secret);
      }
    } catch (error) {
      // 24000002 = not found. Anything else keeps the record for a later launch.
      const code = (error as BusinessError).code;
      if (code !== 24000002) {
        hilog.warn(DOMAIN, 'Ting', 'credential restore skipped for %{public}s', account);
      }
    }
  }
  return result;
}

export function saveCredential(account: string, value: string): void {
  const alias = aliasOf(account);
  const attributes: asset.AssetMap = new Map();
  attributes.set(asset.Tag.ALIAS, alias);
  attributes.set(asset.Tag.SECRET, bytes(value));
  attributes.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_FIRST_UNLOCKED);
  attributes.set(asset.Tag.SYNC_TYPE, asset.SyncType.NEVER);
  const query: asset.AssetMap = new Map();
  query.set(asset.Tag.ALIAS, alias);
  const update: asset.AssetMap = new Map();
  update.set(asset.Tag.SECRET, bytes(value));
  asset.update(query, update).catch((): Promise<void> => asset.add(attributes)).catch((error: Error) => {
    hilog.error(DOMAIN, 'Ting', 'credential save failed for %{public}s: %{public}s', account, String(error?.message));
  });
}

export function removeCredential(account: string): void {
  const query: asset.AssetMap = new Map();
  query.set(asset.Tag.ALIAS, aliasOf(account));
  asset.remove(query).catch((error: BusinessError) => {
    if (error.code !== 24000002) {
      hilog.error(DOMAIN, 'Ting', 'credential remove failed for %{public}s', account);
    }
  });
}
