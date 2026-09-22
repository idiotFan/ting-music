import { NativeAbility } from '@ohos-rs/ability';
import { AbilityConstant, Want } from '@kit.AbilityKit';
import window from '@ohos.window';
import { hilog } from '@kit.PerformanceAnalysisKit';
import ting from 'libting_music_lib.so';
import { TingBridge } from '../bridge/TingBridge';
import { loadCredentials } from '../bridge/Credentials';

const DOMAIN = 0x0000;

export default class EntryAbility extends NativeAbility {
  public moduleName: string = 'ting_music_lib';
  public defaultPage: boolean = true;
  public mode: 'xcomponent' | 'webview' = 'webview';
  private bridge: TingBridge | null = null;

  async onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): Promise<void> {
    // Rust reads the stored sessions during Tauri setup, so seed them before the
    // native module initializes. Values never reach the WebView.
    const seed: Record<string, Object> = {
      'filesDir': this.context.filesDir,
      'cacheDir': this.context.cacheDir,
      'credentials': loadCredentials(),
    };
    try {
      ting.bootstrap(JSON.stringify(seed));
    } catch (error) {
      hilog.error(DOMAIN, 'Ting', 'bootstrap failed: %{public}s', String((error as Error)?.message));
    }
    this.bridge = new TingBridge(this.context);
    ting.registerDispatcher((action: string, payload: string): string => {
      return this.bridge!.dispatch(action, payload);
    });
    await super.onCreate(want, launchParam);
  }

  async onWindowStageCreate(windowStage: window.WindowStage): Promise<void> {
    const mainWindow = windowStage.getMainWindowSync();
    await mainWindow.setWindowLayoutFullScreen(false);
    this.bridge?.attachWindow(mainWindow);
    await super.onWindowStageCreate(windowStage);
  }

  onDestroy(): void {
    this.bridge?.destroy();
    super.onDestroy();
  }
}
