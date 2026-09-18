use super::*;
use dbus::{
    arg::{PropMap, Variant},
    channel::{MatchingReceiver, Sender},
    message::SignalArgs,
    Path,
};
use dbus_crossroads::Crossroads;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};
const PLAYER: &str = "org.mpris.MediaPlayer2.Player";
const PATH: &str = "/org/mpris/MediaPlayer2";
struct Player {
    app: tauri::AppHandle,
    snapshot: Snapshot,
    metadata: PropMap,
    updated: Instant,
}
impl Player {
    fn status(&self) -> &'static str {
        match self.snapshot.playback_state {
            Playback::Playing => "Playing",
            Playback::Paused => "Paused",
            Playback::None => "Stopped",
        }
    }
    fn position(&self) -> i64 {
        self.snapshot
            .position
            .as_ref()
            .map(|p| {
                let advance = if self.snapshot.playback_state == Playback::Playing {
                    self.updated.elapsed().as_secs_f64() * p.playback_rate
                } else {
                    0.0
                };
                ((p.position + advance).min(p.duration) * 1_000_000.0) as i64
            })
            .unwrap_or(0)
    }
    fn action(&self, action: &str, value: Option<(&str, f64)>) {
        if self.snapshot.track.is_some() {
            emit(&self.app, action, value);
        }
    }
}
type Shared = Arc<Mutex<Player>>;
pub struct Backend {
    app: tauri::AppHandle,
    state: Shared,
    conn: Arc<dbus::blocking::SyncConnection>,
    alive: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Backend {
    pub const NAME: &'static str = "mpris";
    pub fn new(app: &tauri::AppHandle) -> Result<Self, String> {
        let conn = Arc::new(
            dbus::blocking::SyncConnection::new_session()
                .map_err(|_| "Linux 桌面 D-Bus 会话不可用")?,
        );
        conn.request_name(
            format!("org.mpris.MediaPlayer2.ting.instance{}", std::process::id()),
            false,
            false,
            true,
        )
        .map_err(|_| "MPRIS 注册失败")?;
        let state = Arc::new(Mutex::new(Player {
            app: app.clone(),
            snapshot: Snapshot::default(),
            metadata: PropMap::new(),
            updated: Instant::now(),
        }));
        let mut cr = Crossroads::new();
        let root = cr.register(
            "org.mpris.MediaPlayer2",
            |b: &mut dbus_crossroads::IfaceBuilder<Shared>| {
                b.property("Identity")
                    .get(|_, _| Ok("听 · Ting".to_owned()));
                b.property("DesktopEntry")
                    .get(|_, _| Ok("ting-music".to_owned()));
                b.property("CanQuit").get(|_, _| Ok(false));
                b.property("CanRaise").get(|_, _| Ok(true));
                b.property("HasTrackList").get(|_, _| Ok(false));
                b.property("SupportedUriSchemes")
                    .get(|_, _| Ok(Vec::<String>::new()));
                b.property("SupportedMimeTypes")
                    .get(|_, _| Ok(Vec::<String>::new()));
                b.method("Raise", (), (), |_, s, (): ()| {
                    if let Ok(p) = s.lock() {
                        if let Some(w) = p.app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    Ok(())
                });
            },
        );
        let player = cr.register(PLAYER, |b: &mut dbus_crossroads::IfaceBuilder<Shared>| {
            for (method, action) in [
                ("Play", "play"),
                ("Pause", "pause"),
                ("PlayPause", "toggle"),
                ("Stop", "stop"),
                ("Next", "nexttrack"),
                ("Previous", "previoustrack"),
            ] {
                b.method(method, (), (), move |_, s, (): ()| {
                    if let Ok(p) = s.lock() {
                        p.action(action, None);
                    }
                    Ok(())
                });
            }
            b.method("Seek", ("Offset",), (), |_, s, (offset,): (i64,)| {
                if let Ok(p) = s.lock() {
                    p.action("seekby", Some(("offset", offset as f64 / 1_000_000.0)));
                }
                Ok(())
            });
            b.method(
                "SetPosition",
                ("TrackId", "Position"),
                (),
                |_, s, (id, position): (Path<'static>, i64)| {
                    if let Ok(p) = s.lock() {
                        if p.snapshot
                            .track
                            .as_ref()
                            .is_some_and(|t| track_path(t) == id)
                            && position >= 0
                            && p.snapshot
                                .position
                                .as_ref()
                                .is_some_and(|x| position as f64 / 1_000_000.0 <= x.duration)
                        {
                            p.action("seekto", Some(("seekTime", position as f64 / 1_000_000.0)));
                        }
                    }
                    Ok(())
                },
            );
            b.signal::<(i64,), _>("Seeked", ("Position",));
            b.property("PlaybackStatus")
                .get(|_, s| Ok(s.lock().unwrap().status().to_owned()));
            b.property("Metadata")
                .get(|_, s| Ok(clone_map(&s.lock().unwrap().metadata)));
            b.property("Position")
                .get(|_, s| Ok(s.lock().unwrap().position()))
                .emits_changed_false();
            b.property("Rate").get(|_, _| Ok(1.0f64));
            b.property("MinimumRate").get(|_, _| Ok(1.0f64));
            b.property("MaximumRate").get(|_, _| Ok(1.0f64));
            b.property("Volume")
                .get(|_, s| Ok(s.lock().unwrap().snapshot.volume))
                .set(|_, s, v: f64| {
                    if v.is_finite() {
                        s.lock()
                            .unwrap()
                            .action("volume", Some(("volume", v.clamp(0.0, 1.0))));
                    }
                    Ok(None)
                });
            for name in ["CanPlay", "CanPause", "CanGoNext", "CanGoPrevious"] {
                b.property(name)
                    .get(|_, s| Ok(s.lock().unwrap().snapshot.track.is_some()));
            }
            b.property("CanSeek")
                .get(|_, s| Ok(s.lock().unwrap().snapshot.position.is_some()));
            b.property("CanControl").get(|_, _| Ok(true));
        });
        cr.insert(PATH, &[root, player], state.clone());
        let cr = Mutex::new(cr);
        conn.start_receive(
            dbus::message::MatchRule::new_method_call(),
            Box::new(move |msg, conn| {
                if let Ok(mut cr) = cr.lock() {
                    let _ = cr.handle_message(msg, conn);
                }
                true
            }),
        );
        let alive = Arc::new(AtomicBool::new(true));
        let worker = {
            let alive = alive.clone();
            let conn = conn.clone();
            thread::spawn(move || {
                while alive.load(Ordering::Relaxed) {
                    if conn.process(Duration::from_millis(100)).is_err() {
                        alive.store(false, Ordering::Relaxed);
                        break;
                    }
                }
            })
        };
        Ok(Self {
            app: app.clone(),
            conn,
            state,
            alive,
            worker: Some(worker),
        })
    }
    pub fn update(&mut self, snapshot: &Snapshot) -> Result<(), String> {
        if !self.alive.load(Ordering::Relaxed) {
            return Err("MPRIS 会话已断开".into());
        }
        let mut p = self.state.lock().map_err(|_| "MPRIS 状态不可用")?;
        let mut changed = PropMap::new();
        let track_changed = p.snapshot.track != snapshot.track;
        let duration_changed = p.snapshot.position.as_ref().map(|p| p.duration)
            != snapshot.position.as_ref().map(|p| p.duration);
        if track_changed || duration_changed {
            let mut metadata = PropMap::new();
            if let Some(track) = &snapshot.track {
                metadata.insert("mpris:trackid".into(), Variant(Box::new(track_path(track))));
                for (k, v) in [("xesam:title", &track.title), ("xesam:album", &track.album)] {
                    metadata.insert(k.into(), Variant(Box::new(v.clone())));
                }
                metadata.insert(
                    "xesam:artist".into(),
                    Variant(Box::new(vec![track.artist.clone()])),
                );
                if let Some(pos) = &snapshot.position {
                    metadata.insert(
                        "mpris:length".into(),
                        Variant(Box::new((pos.duration * 1_000_000.0) as i64)),
                    );
                }
                if let Some(path) = super::save_cover(&self.app, track)? {
                    if let Ok(url) = reqwest::Url::from_file_path(path) {
                        metadata.insert("mpris:artUrl".into(), Variant(Box::new(url.to_string())));
                    }
                }
            }
            changed.insert("Metadata".into(), Variant(Box::new(clone_map(&metadata))));
            p.metadata = metadata;
        }
        let expected = p.position();
        p.snapshot = snapshot.clone();
        p.updated = Instant::now();
        changed.insert(
            "PlaybackStatus".into(),
            Variant(Box::new(p.status().to_owned())),
        );
        changed.insert("Volume".into(), Variant(Box::new(snapshot.volume)));
        for name in ["CanPlay", "CanPause", "CanGoNext", "CanGoPrevious"] {
            changed.insert(name.into(), Variant(Box::new(snapshot.track.is_some())));
        }
        changed.insert(
            "CanSeek".into(),
            Variant(Box::new(snapshot.position.is_some())),
        );
        let signal = dbus::blocking::stdintf::org_freedesktop_dbus::PropertiesPropertiesChanged {
            interface_name: PLAYER.into(),
            changed_properties: changed,
            invalidated_properties: vec![],
        };
        self.conn
            .send(signal.to_emit_message(&Path::new(PATH).unwrap()))
            .map_err(|_| "MPRIS 通知失败")?;
        if !track_changed && (p.position() - expected).abs() > 1_000_000 {
            let signal = dbus::Message::new_signal(PATH, PLAYER, "Seeked")
                .map_err(|_| "MPRIS 通知失败")?
                .append1(p.position());
            let _ = self.conn.send(signal);
        }
        Ok(())
    }
}
fn clone_map(map: &PropMap) -> PropMap {
    map.iter()
        .map(|(k, v)| (k.clone(), Variant(v.0.box_clone())))
        .collect()
}
fn track_path(track: &Track) -> Path<'static> {
    // Frontend generation is numeric; encode all bytes anyway to keep a valid path.
    let id: String = track.track_id.bytes().map(|b| format!("{b:02x}")).collect();
    Path::new(format!("/org/mpris/MediaPlayer2/track/t{id}")).unwrap()
}
impl Drop for Backend {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
