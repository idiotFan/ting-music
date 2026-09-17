//! Per-field Lamport registers. Device snapshots merge without overwriting other edits.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
const MAX_ID: u64 = 9_007_199_254_740_991;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Song {
    pub id: u64,
    #[serde(default = "netease")]
    pub source: String,
    #[serde(default)]
    pub mid: Option<String>,
    pub name: String,
    pub artist: String,
    pub album: String,
    pub cover: String,
    pub duration: f64,
    pub fee: i32,
}
fn netease() -> String {
    "netease".into()
}
impl Song {
    pub fn key(&self) -> String {
        format!("{}:{}", self.source, self.id)
    }
    fn valid(&self) -> bool {
        self.id > 0
            && self.id <= MAX_ID
            && matches!(self.source.as_str(), "netease" | "qq")
            && [&self.name, &self.artist, &self.album]
                .iter()
                .all(|s| s.len() <= 4096)
            && self.cover.len() <= 4096
            && self.duration.is_finite()
            && (0.0..=86_400_000.0).contains(&self.duration)
            && self
                .mid
                .as_ref()
                .is_none_or(|s| s.len() <= 128 && s.bytes().all(|c| c.is_ascii_alphanumeric()))
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
struct Stamp {
    counter: u64,
    device: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Register<T> {
    stamp: Stamp,
    value: T,
}
impl<T: Clone> Register<T> {
    fn merge(&mut self, other: &Self) {
        if other.stamp > self.stamp {
            *self = other.clone();
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Track {
    song: Register<Song>,
    present: Register<bool>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct List {
    alive: Register<bool>,
    name: Register<String>,
    order: Register<Vec<String>>,
    tracks: BTreeMap<String, Track>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Document {
    pub version: u32,
    clock: u64,
    lists: BTreeMap<u64, List>,
}
impl Default for Document {
    fn default() -> Self {
        Self {
            version: 1,
            clock: 0,
            lists: BTreeMap::new(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub id: u64,
    #[serde(default)]
    pub create: bool,
    #[serde(default)]
    pub deleted: bool,
    pub name: Option<String>,
    #[serde(default)]
    pub add: Vec<Song>,
    #[serde(default)]
    pub remove: Vec<String>,
    pub order: Option<Vec<String>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Batch {
    pub id: String,
    pub changes: Vec<Change>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: u64,
    pub name: String,
    pub songs: Vec<Song>,
    pub internal: bool,
    pub cover: String,
    pub creator: String,
    pub owned: bool,
    pub track_count: usize,
}
fn valid_key(s: &str) -> bool {
    s.split_once(':').is_some_and(|(source, id)| {
        matches!(source, "qq" | "netease") && id.parse::<u64>().is_ok_and(|v| v > 0 && v <= MAX_ID)
    })
}
impl Document {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 || self.clock > MAX_ID || self.lists.len() > 2000 {
            return Err("同步文件版本或大小不受支持".into());
        }
        let stamp = |s: &Stamp| s.counter <= self.clock && uuid::Uuid::parse_str(&s.device).is_ok();
        for (id, p) in &self.lists {
            if *id == 0
                || *id > MAX_ID
                || p.name.value.len() > 4096
                || p.order.value.len() > 20000
                || p.tracks.len() > 20000
                || !stamp(&p.alive.stamp)
                || !stamp(&p.name.stamp)
                || !stamp(&p.order.stamp)
                || p.order.value.iter().any(|s| !valid_key(s))
                || p.tracks.iter().any(|(k, t)| {
                    !t.song.value.valid()
                        || t.song.value.key() != *k
                        || !stamp(&t.song.stamp)
                        || !stamp(&t.present.stamp)
                })
            {
                return Err("同步文件内容无效，保留本机歌单".into());
            }
        }
        Ok(())
    }
    pub fn apply(&mut self, batch: &Batch, device: &str) -> Result<(), String> {
        if uuid::Uuid::parse_str(&batch.id).is_err()
            || uuid::Uuid::parse_str(device).is_err()
            || batch.changes.len() > 2000
        {
            return Err("同步修改无效".into());
        }
        let mut next = self.clone();
        next.clock = next
            .clock
            .checked_add(1)
            .filter(|n| *n <= MAX_ID)
            .ok_or("同步版本已超出限制")?;
        let stamp = Stamp {
            counter: next.clock,
            device: device.into(),
        };
        for c in &batch.changes {
            if c.id == 0
                || c.id > MAX_ID
                || c.add.len() > 20000
                || c.remove.len() > 20000
                || c.add.iter().any(|s| !s.valid())
                || c.remove.iter().any(|s| !valid_key(s))
            {
                return Err("歌单修改无效".into());
            }
            if c.create {
                next.lists.entry(c.id).or_insert_with(|| List {
                    alive: Register {
                        stamp: stamp.clone(),
                        value: true,
                    },
                    name: Register {
                        stamp: stamp.clone(),
                        value: c.name.clone().unwrap_or_default(),
                    },
                    order: Register {
                        stamp: stamp.clone(),
                        value: Vec::new(),
                    },
                    tracks: BTreeMap::new(),
                });
            }
            let p = next.lists.get_mut(&c.id).ok_or("歌单同步记录不存在")?;
            // Editing a deleted playlist does not resurrect it. Deletion is permanent for this ID.
            if c.deleted {
                p.alive = Register {
                    stamp: stamp.clone(),
                    value: false,
                };
            }
            if let Some(name) = &c.name {
                p.name = Register {
                    stamp: stamp.clone(),
                    value: name.clone(),
                };
            }
            for song in &c.add {
                p.tracks.insert(
                    song.key(),
                    Track {
                        song: Register {
                            stamp: stamp.clone(),
                            value: song.clone(),
                        },
                        present: Register {
                            stamp: stamp.clone(),
                            value: true,
                        },
                    },
                );
            }
            for key in &c.remove {
                if let Some(t) = p.tracks.get_mut(key) {
                    t.present = Register {
                        stamp: stamp.clone(),
                        value: false,
                    };
                }
            }
            if let Some(order) = &c.order {
                p.order = Register {
                    stamp: stamp.clone(),
                    value: order.clone(),
                };
            }
        }
        next.validate()?;
        *self = next;
        Ok(())
    }
    pub fn merge(&mut self, other: &Self) -> Result<(), String> {
        other.validate()?;
        for (id, b) in &other.lists {
            if let Some(a) = self.lists.get_mut(id) {
                a.alive.merge(&b.alive);
                a.name.merge(&b.name);
                a.order.merge(&b.order);
                for (key, t) in &b.tracks {
                    if let Some(existing) = a.tracks.get_mut(key) {
                        existing.song.merge(&t.song);
                        existing.present.merge(&t.present);
                    } else {
                        a.tracks.insert(key.clone(), t.clone());
                    }
                }
            } else {
                self.lists.insert(*id, b.clone());
            }
        }
        self.clock = self.clock.max(other.clock);
        self.validate()
    }
    pub fn playlists(&self) -> Vec<Playlist> {
        self.lists
            .iter()
            .filter(|(_, p)| p.alive.value)
            .map(|(id, p)| {
                let mut keys = p.order.value.clone();
                let ordered: BTreeSet<_> = keys.iter().cloned().collect();
                let mut extra: Vec<_> = p
                    .tracks
                    .iter()
                    .filter(|(k, t)| t.present.value && !ordered.contains(*k))
                    .collect();
                extra.sort_by(|a, b| a.1.present.stamp.cmp(&b.1.present.stamp).then(a.0.cmp(b.0)));
                keys.extend(extra.into_iter().map(|(k, _)| k.clone()));
                let mut seen = BTreeSet::new();
                let songs: Vec<_> = keys
                    .into_iter()
                    .filter(|k| seen.insert(k.clone()))
                    .filter_map(|k| p.tracks.get(&k))
                    .filter(|t| t.present.value)
                    .map(|t| t.song.value.clone())
                    .collect();
                Playlist {
                    id: *id,
                    name: p.name.value.clone(),
                    cover: songs.first().map(|s| s.cover.clone()).unwrap_or_default(),
                    track_count: songs.len(),
                    songs,
                    internal: true,
                    creator: "本机".into(),
                    owned: true,
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const A: &str = "00000000-0000-4000-8000-000000000001";
    const B: &str = "00000000-0000-4000-8000-000000000002";
    fn song(id: u64) -> Song {
        Song {
            id,
            source: "netease".into(),
            mid: None,
            name: format!("曲目{id}"),
            artist: "歌手".into(),
            album: "专辑".into(),
            cover: "".into(),
            duration: 120000.0,
            fee: 0,
        }
    }
    fn change(id: u64) -> Change {
        Change {
            id,
            create: false,
            deleted: false,
            name: None,
            add: vec![],
            remove: vec![],
            order: None,
        }
    }
    fn edit(doc: &mut Document, device: &str, c: Change) {
        doc.apply(
            &Batch {
                id: uuid::Uuid::new_v4().to_string(),
                changes: vec![c],
            },
            device,
        )
        .unwrap();
    }
    fn initial() -> Document {
        let mut d = Document::default();
        let mut c = change(1);
        c.create = true;
        c.name = Some("一起听".into());
        c.add = vec![song(1), song(2)];
        c.order = Some(vec!["netease:1".into(), "netease:2".into()]);
        edit(&mut d, A, c);
        d
    }
    #[test]
    fn independent_additions_and_rename_merge_in_both_directions() {
        let mut a = initial();
        let mut b = a.clone();
        let mut c = change(1);
        c.add = vec![song(3)];
        edit(&mut a, A, c);
        let mut c = change(1);
        c.add = vec![song(4)];
        c.name = Some("新名字".into());
        edit(&mut b, B, c);
        let before = a.clone();
        a.merge(&b).unwrap();
        b.merge(&before).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.playlists()[0].songs.len(), 4);
        assert_eq!(a.playlists()[0].name, "新名字");
        let copy = a.clone();
        a.merge(&copy).unwrap();
        assert_eq!(a, copy);
    }
    #[test]
    fn old_snapshot_cannot_resurrect_removed_track_or_playlist() {
        let old = initial();
        let mut a = old.clone();
        let mut c = change(1);
        c.remove = vec!["netease:1".into()];
        edit(&mut a, A, c);
        a.merge(&old).unwrap();
        assert_eq!(a.playlists()[0].songs.len(), 1);
        let mut c = change(1);
        c.deleted = true;
        edit(&mut a, A, c);
        let mut b = old.clone();
        let mut c = change(1);
        c.name = Some("离线改名".into());
        edit(&mut b, B, c);
        a.merge(&b).unwrap();
        b.merge(&a).unwrap();
        assert!(a.playlists().is_empty());
        assert!(b.playlists().is_empty());
    }
    #[test]
    fn reorder_and_concurrent_add_keep_all_live_tracks() {
        let mut a = initial();
        let mut b = a.clone();
        let mut c = change(1);
        c.order = Some(vec!["netease:2".into(), "netease:1".into()]);
        edit(&mut a, A, c);
        let mut c = change(1);
        c.add = vec![song(3)];
        edit(&mut b, B, c);
        a.merge(&b).unwrap();
        assert_eq!(
            a.playlists()[0]
                .songs
                .iter()
                .map(|s| s.id)
                .collect::<Vec<_>>(),
            vec![2, 1, 3]
        );
    }
    #[test]
    fn readd_after_observed_delete_and_source_ids_are_independent() {
        let mut a = initial();
        let mut c = change(1);
        c.remove = vec!["netease:1".into()];
        edit(&mut a, A, c);
        let mut b = a.clone();
        let mut c = change(1);
        let mut qq = song(1);
        qq.source = "qq".into();
        qq.mid = Some("abc123".into());
        c.add = vec![song(1), qq];
        edit(&mut b, B, c);
        a.merge(&b).unwrap();
        assert_eq!(a.playlists()[0].songs.len(), 3);
    }
    #[test]
    fn concurrent_reorders_converge_and_bad_batches_are_atomic() {
        let mut a = initial();
        let mut b = a.clone();
        let mut c = change(1);
        c.order = Some(vec!["netease:2".into(), "netease:1".into()]);
        edit(&mut a, A, c);
        let mut c = change(1);
        c.order = Some(vec!["netease:1".into(), "netease:2".into()]);
        edit(&mut b, B, c);
        let old = a.clone();
        a.merge(&b).unwrap();
        b.merge(&old).unwrap();
        assert_eq!(a.playlists(), b.playlists());
        let before = a.clone();
        let mut c = change(1);
        c.name = Some("不应提交".into());
        c.add = vec![song(MAX_ID + 1)];
        assert!(a
            .apply(
                &Batch {
                    id: uuid::Uuid::new_v4().to_string(),
                    changes: vec![c]
                },
                A
            )
            .is_err());
        assert_eq!(before, a);
    }
    #[test]
    fn documents_reject_new_versions_and_unexpected_credentials() {
        let mut d = initial();
        d.version = 2;
        assert!(d.validate().is_err());
        assert!(serde_json::from_str::<Document>(
            r#"{"version":1,"clock":0,"lists":{},"cookie":"private"}"#
        )
        .is_err());
        let mut d = initial();
        d.lists
            .get_mut(&1)
            .unwrap()
            .order
            .value
            .push("local:1".into());
        assert!(d.validate().is_err());
    }
}
