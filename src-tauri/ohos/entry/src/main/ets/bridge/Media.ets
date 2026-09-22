import { avSession } from '@kit.AVSessionKit';
import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { wantAgent, WantAgent } from '@kit.AbilityKit';
import common from '@ohos.app.ability.common';
import { hilog } from '@kit.PerformanceAnalysisKit';
import ting from 'libting_music_lib.so';

const DOMAIN = 0x0000;

interface Track {
  trackId: string;
  title: string;
  artist: string;
  album: string;
  artwork?: string;
}

interface Position {
  duration: number;
  position: number;
  playbackRate: number;
}

interface Snapshot {
  track?: Track;
  playbackState: string;
  position?: Position;
  volume: number;
}

/**
 * The system media owner on HarmonyOS. Metadata and transport state come from
 * Rust snapshots; control-center commands go back through ting.mediaCommand and
 * rejoin the single playback queue. Audio keeps playing in the background via a
 * continuous task that starts with playback and stops with pause.
 */
export class TingMedia {
  private readonly context: common.UIAbilityContext;
  private session: avSession.AVSession | null = null;
  private creating: Promise<void> | null = null;
  private pending: Snapshot | null = null;
  private artwork: string = '';
  private assetId: string = '';
  private background: boolean = false;

  constructor(context: common.UIAbilityContext) {
    this.context = context;
  }

  init(): void {
    if (this.session || this.creating) {
      return;
    }
    this.creating = avSession.createAVSession(this.context, 'ting', 'audio')
      .then(async (session: avSession.AVSession) => {
        session.on('play', () => ting.mediaCommand('play'));
        session.on('pause', () => ting.mediaCommand('pause'));
        session.on('stop', () => ting.mediaCommand('stop'));
        session.on('playNext', () => ting.mediaCommand('nexttrack'));
        session.on('playPrevious', () => ting.mediaCommand('previoustrack'));
        session.on('seek', (time: number) => ting.mediaCommand('seekto', time / 1000));
        await session.activate();
        this.session = session;
        if (this.pending) {
          const snapshot = this.pending;
          this.pending = null;
          this.apply(snapshot, true);
        }
      })
      .catch((error: Error) => {
        hilog.error(DOMAIN, 'Ting', 'AVSession unavailable: %{public}s', String(error?.message));
      })
      .finally(() => {
        this.creating = null;
      });
  }

  update(raw: Record<string, Object>, artworkChanged: boolean): void {
    const snapshot = raw as Snapshot;
    if (!this.session) {
      this.pending = snapshot;
      this.init();
      return;
    }
    this.apply(snapshot, artworkChanged);
  }

  private apply(snapshot: Snapshot, artworkChanged: boolean): void {
    const session = this.session;
    if (!session) {
      return;
    }
    const track = snapshot.track;
    if (track) {
      if (artworkChanged && typeof track.artwork === 'string') {
        this.artwork = track.artwork;
      }
      const metadata: avSession.AVMetadata = {
        assetId: track.trackId,
        title: track.title,
        artist: track.artist,
        album: track.album,
      };
      if (snapshot.position && snapshot.position.duration > 0) {
        metadata.duration = Math.round(snapshot.position.duration * 1000);
      }
      // AVSession accepts an https URL; the platform CDN already served it to the WebView.
      if (this.artwork.startsWith('https://')) {
        metadata.mediaImage = this.artwork;
      }
      if (this.assetId !== track.trackId || artworkChanged) {
        this.assetId = track.trackId;
        session.setAVMetadata(metadata).catch((error: Error) => {
          hilog.warn(DOMAIN, 'Ting', 'metadata rejected: %{public}s', String(error?.message));
        });
      }
    } else {
      this.assetId = '';
      this.artwork = '';
      session.setAVMetadata({ assetId: '' } as avSession.AVMetadata).catch(() => {});
    }
    const playing = snapshot.playbackState === 'playing';
    const state: avSession.AVPlaybackState = {
      state: playing
        ? avSession.PlaybackState.PLAYBACK_STATE_PLAY
        : snapshot.playbackState === 'paused'
          ? avSession.PlaybackState.PLAYBACK_STATE_PAUSE
          : avSession.PlaybackState.PLAYBACK_STATE_STOP,
      speed: snapshot.position?.playbackRate ?? 1,
    };
    if (snapshot.position) {
      state.position = {
        elapsedTime: Math.round(snapshot.position.position * 1000),
        updateTime: Date.now(),
      };
    }
    session.setAVPlaybackState(state).catch((error: Error) => {
      hilog.warn(DOMAIN, 'Ting', 'playback state rejected: %{public}s', String(error?.message));
    });
    this.setBackground(playing);
  }

  private setBackground(playing: boolean): void {
    if (playing === this.background) {
      return;
    }
    this.background = playing;
    if (!playing) {
      backgroundTaskManager.stopBackgroundRunning(this.context).catch(() => {});
      return;
    }
    const info: wantAgent.WantAgentInfo = {
      wants: [{ bundleName: this.context.abilityInfo.bundleName, abilityName: this.context.abilityInfo.name }],
      actionType: wantAgent.OperationType.START_ABILITY,
      requestCode: 0,
      actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG],
    };
    wantAgent.getWantAgent(info)
      .then((agent: WantAgent) => backgroundTaskManager.startBackgroundRunning(
        this.context, backgroundTaskManager.BackgroundMode.AUDIO_PLAYBACK, agent))
      .catch((error: Error) => {
        this.background = false;
        hilog.warn(DOMAIN, 'Ting', 'background playback not granted: %{public}s', String(error?.message));
      });
  }

  destroy(): void {
    this.setBackground(false);
    const session = this.session;
    this.session = null;
    this.pending = null;
    session?.destroy().catch(() => {});
  }
}
