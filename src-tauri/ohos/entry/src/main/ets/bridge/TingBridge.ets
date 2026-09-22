import common from '@ohos.app.ability.common';
import window from '@ohos.window';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { saveCredential, removeCredential } from './Credentials';
import { TingMedia } from './Media';
import { openDownloads } from './Downloads';
import { saveQr } from './Qr';

const DOMAIN = 0x0000;

/**
 * One synchronous entry point for Rust. Every action answers a JSON string at
 * once; slow system calls continue in the background and report through logs,
 * never through credential values or upstream error bodies.
 */
export class TingBridge {
  private readonly context: common.UIAbilityContext;
  private readonly media: TingMedia;
  private mainWindow: window.Window | null = null;

  constructor(context: common.UIAbilityContext) {
    this.context = context;
    this.media = new TingMedia(context);
  }

  attachWindow(mainWindow: window.Window): void {
    this.mainWindow = mainWindow;
  }

  destroy(): void {
    this.media.destroy();
  }

  dispatch(action: string, payload: string): string {
    try {
      const args = JSON.parse(payload) as Record<string, Object>;
      switch (action) {
        case 'credential.save':
          saveCredential(String(args['account']), String(args['value']));
          return ok();
        case 'credential.remove':
          removeCredential(String(args['account']));
          return ok();
        case 'media.init':
          this.media.init();
          return ok();
        case 'media.update':
          this.media.update(JSON.stringify(args['snapshot']), args['artworkChanged'] === true);
          return ok();
        case 'downloads.open':
          if (!this.mainWindow) {
            return fail('窗口尚未就绪');
          }
          openDownloads(this.context, this.mainWindow.getUIContext(), String(args['dir']));
          return ok();
        case 'qr.save':
          saveQr(this.context, String(args['dataUrl']));
          return ok();
        default:
          return fail(`未知操作 ${action}`);
      }
    } catch (error) {
      hilog.error(DOMAIN, 'Ting', '%{public}s failed: %{public}s', action, String((error as Error)?.message));
      return fail('鸿蒙系统操作未完成，请重试');
    }
  }
}

function ok(): string {
  return JSON.stringify({ 'ok': true } as Record<string, Object>);
}

function fail(message: string): string {
  return JSON.stringify({ 'error': message } as Record<string, Object>);
}
