use super::*;
use ::windows::{
    core::{Ref, HSTRING},
    Foundation::{TimeSpan, TypedEventHandler},
    Media::*,
    Storage::{StorageFile, Streams::RandomAccessStreamReference},
    Win32::System::WinRT::ISystemMediaTransportControlsInterop,
};

pub struct Backend {
    app: tauri::AppHandle,
    controls: SystemMediaTransportControls,
    buttons: i64,
    position: i64,
    previous: Option<Track>,
}
impl Backend {
    pub const NAME: &'static str = "windows";
    pub fn new(app: &tauri::AppHandle) -> Result<Self, String> {
        let result = (|| -> ::windows::core::Result<Self> {
            let window = app
                .get_webview_window("main")
                .ok_or_else(::windows::core::Error::empty)?;
            let hwnd = window.hwnd().map_err(|_| ::windows::core::Error::empty())?;
            let factory: ISystemMediaTransportControlsInterop = ::windows::core::factory::<
                SystemMediaTransportControls,
                ISystemMediaTransportControlsInterop,
            >()?;
            let controls: SystemMediaTransportControls = unsafe { factory.GetForWindow(hwnd)? };
            controls.SetIsFastForwardEnabled(false)?;
            controls.SetIsRewindEnabled(false)?;
            let handle = app.clone();
            let buttons = controls.ButtonPressed(&TypedEventHandler::new(
                move |_, args: Ref<'_, SystemMediaTransportControlsButtonPressedEventArgs>| {
                    if let Some(args) = args.as_ref() {
                        let action = match args.Button()? {
                            SystemMediaTransportControlsButton::Play => "play",
                            SystemMediaTransportControlsButton::Pause => "pause",
                            SystemMediaTransportControlsButton::Stop => "stop",
                            SystemMediaTransportControlsButton::Next => "nexttrack",
                            SystemMediaTransportControlsButton::Previous => "previoustrack",
                            _ => return Ok(()),
                        };
                        emit(&handle, action, None);
                    }
                    Ok(())
                },
            ))?;
            let handle = app.clone();
            let position = match controls.PlaybackPositionChangeRequested(&TypedEventHandler::new(
                move |_, args: Ref<'_, PlaybackPositionChangeRequestedEventArgs>| {
                    if let Some(args) = args.as_ref() {
                        emit(
                            &handle,
                            "seekto",
                            Some((
                                "seekTime",
                                args.RequestedPlaybackPosition()?.Duration as f64 / 10_000_000.0,
                            )),
                        );
                    }
                    Ok(())
                },
            )) {
                Ok(token) => token,
                Err(error) => {
                    let _ = controls.RemoveButtonPressed(buttons);
                    return Err(error);
                }
            };
            Ok(Self {
                app: app.clone(),
                controls,
                buttons,
                position,
                previous: None,
            })
        })();
        result.map_err(|_| "Windows 系统媒体初始化失败".into())
    }
    pub fn update(&mut self, snapshot: &Snapshot) -> Result<(), String> {
        let result = (|| -> ::windows::core::Result<()> {
            let active = snapshot.track.is_some();
            self.controls.SetIsEnabled(active)?;
            self.controls.SetIsPlayEnabled(active)?;
            self.controls.SetIsPauseEnabled(active)?;
            self.controls.SetIsStopEnabled(active)?;
            self.controls.SetIsNextEnabled(active)?;
            self.controls.SetIsPreviousEnabled(active)?;
            if self.previous != snapshot.track {
                let updater = self.controls.DisplayUpdater()?;
                updater.ClearAll()?;
                updater.SetType(MediaPlaybackType::Music)?;
                if let Some(track) = &snapshot.track {
                    let props = updater.MusicProperties()?;
                    props.SetTitle(&HSTRING::from(&track.title))?;
                    props.SetArtist(&HSTRING::from(&track.artist))?;
                    props.SetAlbumTitle(&HSTRING::from(&track.album))?;
                    // Artwork is optional. A full/unavailable cache or image load
                    // failure must not suppress title, playback status or buttons.
                    if let Some(thumbnail) = thumbnail(&self.app, track) {
                        let _ = updater.SetThumbnail(&thumbnail);
                    }
                }
                updater.Update()?;
                self.previous = snapshot.track.clone();
            }
            let status = match snapshot.playback_state {
                Playback::Playing => MediaPlaybackStatus::Playing,
                Playback::Paused => MediaPlaybackStatus::Paused,
                Playback::None => MediaPlaybackStatus::Stopped,
            };
            self.controls.SetPlaybackStatus(status)?;
            let timeline = SystemMediaTransportControlsTimelineProperties::new()?;
            let (duration, position) = snapshot
                .position
                .as_ref()
                .map(|p| (p.duration, p.position))
                .unwrap_or((0.0, 0.0));
            let span = |seconds: f64| TimeSpan {
                Duration: (seconds * 10_000_000.0) as i64,
            };
            timeline.SetStartTime(span(0.0))?;
            timeline.SetMinSeekTime(span(0.0))?;
            timeline.SetEndTime(span(duration))?;
            timeline.SetMaxSeekTime(span(duration))?;
            timeline.SetPosition(span(position))?;
            self.controls.UpdateTimelineProperties(&timeline)?;
            Ok(())
        })();
        result.map_err(|_| "Windows 系统媒体更新失败".into())
    }
}
fn thumbnail(app: &tauri::AppHandle, track: &Track) -> Option<RandomAccessStreamReference> {
    let path = super::save_cover(app, track).ok()??;
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path.to_string_lossy().as_ref()))
        .ok()?
        .get()
        .ok()?;
    RandomAccessStreamReference::CreateFromFile(&file).ok()
}
impl Drop for Backend {
    fn drop(&mut self) {
        let _ = self.controls.SetIsEnabled(false);
        let _ = self.controls.RemoveButtonPressed(self.buttons);
        let _ = self
            .controls
            .RemovePlaybackPositionChangeRequested(self.position);
    }
}
