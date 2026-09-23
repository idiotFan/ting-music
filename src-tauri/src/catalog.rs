//! NetEase catalog pages beyond song search: artists, albums and public
//! playlists. Shapes are shared with the QQ side (see qq/client.rs) so the
//! frontend renders one kind of page for both platforms.
use crate::netease::{https_url, songs_from, string, Api, Song};
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Artist {
    pub source: &'static str,
    pub id: u64,
    pub mid: String,
    pub name: String,
    pub avatar: String,
    pub album_count: u64,
    pub song_count: u64,
    pub alias: String,
}
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    pub source: &'static str,
    pub id: u64,
    pub mid: String,
    pub name: String,
    pub artist: String,
    pub artist_id: u64,
    pub artist_mid: String,
    pub cover: String,
    pub publish_time: u64,
    pub track_count: u64,
}
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PublicPlaylist {
    pub source: &'static str,
    pub id: u64,
    pub name: String,
    pub cover: String,
    pub track_count: u64,
    pub creator: String,
    pub owned: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPage {
    pub artists: Vec<Artist>,
    pub albums: Vec<Album>,
    pub playlists: Vec<PublicPlaylist>,
    pub total: u64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistPage {
    pub artist: Artist,
    pub brief: String,
    pub songs: Vec<Song>,
    pub similar: Vec<Artist>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumList {
    pub albums: Vec<Album>,
    pub total: u64,
    pub more: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumPage {
    pub album: Album,
    pub description: String,
    pub songs: Vec<Song>,
}

const PAGE: u32 = 30;

pub fn artist(v: &Value) -> Option<Artist> {
    let id = v["id"].as_u64().filter(|id| *id > 0)?;
    Some(Artist {
        source: "netease",
        id,
        mid: String::new(),
        name: string(&v["name"]),
        avatar: https_url(&string(if v["img1v1Url"].is_string() {
            &v["img1v1Url"]
        } else {
            &v["picUrl"]
        })),
        album_count: v["albumSize"].as_u64().unwrap_or(0),
        song_count: v["musicSize"].as_u64().unwrap_or(0),
        alias: v["alias"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(Value::as_str)
            .or_else(|| v["trans"].as_str())
            .unwrap_or_default()
            .to_owned(),
    })
}
pub fn album(v: &Value) -> Option<Album> {
    let id = v["id"].as_u64().filter(|id| *id > 0)?;
    let artists = v["artists"].as_array().cloned().unwrap_or_default();
    let names: Vec<&str> = artists.iter().filter_map(|a| a["name"].as_str()).collect();
    let main = if v["artist"].is_object() {
        &v["artist"]
    } else {
        artists.first().unwrap_or(&Value::Null)
    };
    Some(Album {
        source: "netease",
        id,
        mid: String::new(),
        name: string(&v["name"]),
        artist: if names.is_empty() {
            string(&main["name"])
        } else {
            names.join(" / ")
        },
        artist_id: main["id"].as_u64().unwrap_or(0),
        artist_mid: String::new(),
        cover: https_url(&string(&v["picUrl"])),
        publish_time: v["publishTime"].as_u64().unwrap_or(0),
        track_count: v["size"].as_u64().unwrap_or(0),
    })
}
fn playlist(v: &Value) -> Option<PublicPlaylist> {
    Some(PublicPlaylist {
        source: "netease",
        id: v["id"].as_u64().filter(|id| *id > 0)?,
        name: string(&v["name"]),
        cover: https_url(&string(&v["coverImgUrl"])),
        track_count: v["trackCount"].as_u64().unwrap_or(0),
        creator: string(&v["creator"]["nickname"]),
        owned: false,
    })
}
fn list<T>(v: &Value, map: fn(&Value) -> Option<T>) -> Vec<T> {
    v.as_array()
        .map(|a| a.iter().filter_map(map).collect())
        .unwrap_or_default()
}

pub fn kind_code(kind: &str) -> Result<u32, String> {
    match kind {
        "artist" => Ok(100),
        "album" => Ok(10),
        "playlist" => Ok(1000),
        _ => Err("不支持的搜索类型".into()),
    }
}

impl Api {
    pub async fn catalog_search(
        &self,
        query: &str,
        kind: &str,
        offset: u32,
    ) -> Result<CatalogPage, String> {
        let query = query.trim();
        if query.is_empty() || query.chars().count() > 100 {
            return Err("请输入 1–100 个字符的搜索词".into());
        }
        let code = kind_code(kind)?;
        let body = self
            .request(
                "cloudsearch/pc",
                json!({"s":query,"type":code,"limit":PAGE,"offset":offset.min(10000)}),
            )
            .await?;
        let r = &body["result"];
        Ok(CatalogPage {
            artists: list(&r["artists"], artist),
            albums: list(&r["albums"], album),
            playlists: list(&r["playlists"], playlist),
            total: r["artistCount"]
                .as_u64()
                .or_else(|| r["albumCount"].as_u64())
                .or_else(|| r["playlistCount"].as_u64())
                .unwrap_or(0),
        })
    }
    pub async fn artist_page(&self, id: u64) -> Result<ArtistPage, String> {
        if id == 0 {
            return Err("歌手 ID 无效".into());
        }
        let body = self.request(&format!("v1/artist/{id}"), json!({})).await?;
        let artist = artist(&body["artist"]).ok_or("没有找到这位歌手")?;
        // NetEase only answers this for signed-in accounts; the page simply
        // goes without the section otherwise.
        let similar = self
            .request("discovery/simiArtist", json!({"artistid":id}))
            .await
            .map(|v| list(&v["artists"], self::artist))
            .unwrap_or_default();
        Ok(ArtistPage {
            brief: string(&body["artist"]["briefDesc"]),
            songs: songs_from(&body["hotSongs"]),
            artist,
            similar: similar.into_iter().take(12).collect(),
        })
    }
    pub async fn artist_albums(&self, id: u64, offset: u32) -> Result<AlbumList, String> {
        if id == 0 {
            return Err("歌手 ID 无效".into());
        }
        let body = self
            .request(
                &format!("artist/albums/{id}"),
                json!({"limit":PAGE,"offset":offset.min(10000),"total":true}),
            )
            .await?;
        let albums = list(&body["hotAlbums"], album);
        let total = body["artist"]["albumSize"].as_u64().unwrap_or(0);
        Ok(AlbumList {
            more: body["more"] == true,
            total: total.max(offset as u64 + albums.len() as u64),
            albums,
        })
    }
    pub async fn album_page(&self, id: u64) -> Result<AlbumPage, String> {
        if id == 0 {
            return Err("专辑 ID 无效".into());
        }
        let body = self.request(&format!("v1/album/{id}"), json!({})).await?;
        let mut album = album(&body["album"]).ok_or("没有找到这张专辑")?;
        let songs = songs_from(&body["songs"]);
        album.track_count = album.track_count.max(songs.len() as u64);
        // Album tracks often omit the cover; inherit the album's.
        let songs = songs
            .into_iter()
            .map(|mut s| {
                if s.cover.is_empty() {
                    s.cover = album.cover.clone();
                }
                if s.album_id == 0 {
                    s.album_id = album.id;
                }
                s
            })
            .collect();
        Ok(AlbumPage {
            description: string(&body["album"]["description"]),
            album,
            songs,
        })
    }
}

#[tauri::command]
pub async fn catalog_search(
    api: tauri::State<'_, Api>,
    query: String,
    kind: String,
    offset: u32,
) -> Result<CatalogPage, String> {
    api.catalog_search(&query, &kind, offset).await
}
#[tauri::command]
pub async fn artist_detail(api: tauri::State<'_, Api>, id: u64) -> Result<ArtistPage, String> {
    api.artist_page(id).await
}
#[tauri::command]
pub async fn artist_albums(
    api: tauri::State<'_, Api>,
    id: u64,
    offset: u32,
) -> Result<AlbumList, String> {
    api.artist_albums(id, offset).await
}
#[tauri::command]
pub async fn album_detail(api: tauri::State<'_, Api>, id: u64) -> Result<AlbumPage, String> {
    api.album_page(id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_search_rows_defensively() {
        let a = artist(&json!({"id":6452,"name":"周杰伦","picUrl":"http://p1/x.jpg","albumSize":40,"alias":["Jay Chou"]})).unwrap();
        assert_eq!(a.avatar, "https://p1/x.jpg");
        assert_eq!(a.alias, "Jay Chou");
        assert!(artist(&json!({"id":0,"name":"x"})).is_none());
        let al = album(&json!({"id":1,"name":"叶惠美","picUrl":"http://p/a.jpg","artists":[{"id":6452,"name":"周杰伦"},{"id":2,"name":"B"}],"size":11,"publishTime":1059580800000u64})).unwrap();
        assert_eq!(al.artist, "周杰伦 / B");
        assert_eq!(al.artist_id, 6452);
        assert_eq!(al.track_count, 11);
        assert!(kind_code("song").is_err());
    }
    #[test]
    fn songs_carry_artist_and_album_ids() {
        let songs = songs_from(
            &json!([{"id":5,"name":"晴天","ar":[{"id":6452,"name":"周杰伦"}],"al":{"id":18905,"name":"叶惠美","picUrl":"http://p/c.jpg"},"dt":269000,"fee":8},
            {"id":6,"name":"旧接口","artists":[{"id":1,"name":"A"}],"album":{"id":2,"name":"B","picUrl":""},"duration":1000}]),
        );
        assert_eq!(songs[0].artists[0].id, 6452);
        assert_eq!(songs[0].album_id, 18905);
        assert_eq!(songs[1].artist, "A");
        assert_eq!(songs[1].album_id, 2);
        assert_eq!(songs[1].duration, 1000);
    }
    #[tokio::test]
    #[ignore = "public read-only NetEase catalog smoke test"]
    async fn live_artist_album_catalog() {
        let api = Api::new().unwrap();
        let found = api.catalog_search("周杰伦", "artist", 0).await.unwrap();
        let jay = found.artists.first().expect("artist result");
        let page = api.artist_page(jay.id).await.unwrap();
        assert!(!page.songs.is_empty(), "hot songs");
        assert!(page.songs[0].album_id > 0);
        let albums = api.artist_albums(jay.id, 0).await.unwrap();
        let first = albums.albums.first().expect("albums");
        let album = api.album_page(first.id).await.unwrap();
        assert!(!album.songs.is_empty());
        let lists = api.catalog_search("周杰伦", "playlist", 0).await.unwrap();
        assert!(!lists.playlists.is_empty());
        let albums = api.catalog_search("叶惠美", "album", 0).await.unwrap();
        assert!(!albums.albums.is_empty());
        eprintln!(
            "{} · {} songs · {} albums · album {} has {} tracks",
            page.artist.name,
            page.songs.len(),
            albums.total,
            album.album.name,
            album.songs.len()
        );
    }
}
