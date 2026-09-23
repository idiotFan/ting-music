//! QQ protocol adapter. Protocol reference: QQMusicApi 0.7.3 (see THIRD_PARTY_NOTICES).
//! Credentials remain backend-only; arbitrary upstream error messages never cross IPC.
use crate::http;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use unicode_casefold::UnicodeCaseFold;
use unicode_normalization::UnicodeNormalization;

pub(super) struct Client {
    pub credential: Value,
    pub http: reqwest::Client,
    pub guid: String,
    #[cfg(test)]
    rpc_endpoint: Option<String>,
}
pub(super) fn string(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
pub(super) fn number(v: &Value) -> u64 {
    v.as_u64().or_else(|| v.as_str()?.parse().ok()).unwrap_or(0)
}
pub(super) fn rows(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub(super) fn hash33(s: &str, seed: u32) -> u32 {
    s.chars()
        .fold(seed, |hash, c| hash.wrapping_mul(33).wrapping_add(c as u32))
        & 0x7fff_ffff
}
pub(super) fn normalize_credential(mut c: Value) -> Result<Value, String> {
    if c.get("musickey")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
        || number(&c["musicid"]) == 0
    {
        return Err("QQ 登录未返回有效凭据，请重新扫码".into());
    }
    for (alias, key) in [
        ("loginType", "login_type"),
        ("encryptUin", "encrypt_uin"),
        ("refreshKey", "refresh_key"),
    ] {
        if !c[alias].is_null() {
            c[key] = c[alias].take();
        }
    }
    if number(&c["login_type"]) == 0 {
        c["login_type"] = json!(if string(&c["musickey"]).starts_with("W_X") {
            1
        } else {
            2
        });
    }
    Ok(c)
}
impl Client {
    pub fn new(credential: Value, guid: String) -> Result<Self, String> {
        let credential = if credential.is_null() {
            json!({})
        } else {
            normalize_credential(credential)?
        };
        Ok(Self {
            credential,
            http: http::client()?,
            guid,
            #[cfg(test)]
            rpc_endpoint: None,
        })
    }
    pub fn uin(&self) -> String {
        let s = string(&self.credential["str_musicid"]);
        if s.is_empty() {
            number(&self.credential["musicid"]).to_string()
        } else {
            s.into()
        }
    }
    pub fn require_login(&self) -> Result<(), String> {
        if number(&self.credential["musicid"]) == 0
            || string(&self.credential["musickey"]).is_empty()
        {
            Err("请先登录 QQ 音乐".into())
        } else {
            Ok(())
        }
    }
    pub fn comm(&self, desktop: bool, login_type: Option<u64>) -> Value {
        let gtk = hash33(string(&self.credential["musickey"]), 5381);
        let mut c = if desktop {
            json!({"ct":19,"cv":2201,"chid":"0","uin":number(&self.credential["musicid"]),"g_tk":gtk,"guid":self.guid.to_uppercase()})
        } else {
            json!({"ct":24,"cv":4747474,"platform":"yqq.json","chid":"0","uin":number(&self.credential["musicid"]),"g_tk":gtk,"g_tk_new_20200303":gtk,"format":"json","inCharset":"utf-8","outCharset":"utf-8","notice":0,"need_new_code":1})
        };
        if !string(&self.credential["musickey"]).is_empty() {
            c["authst"] = self.credential["musickey"].clone();
        }
        let login_type = login_type.unwrap_or(number(&self.credential["login_type"]));
        if login_type != 0 {
            c["tmeLoginType"] = json!(login_type);
        }
        c
    }
    pub async fn rpc(
        &self,
        module: &str,
        method: &str,
        param: Value,
        desktop: bool,
        login_type: Option<u64>,
    ) -> Result<Value, String> {
        let endpoint = "https://u.y.qq.com/cgi-bin/musicu.fcg";
        #[cfg(test)]
        let endpoint = self.rpc_endpoint.as_deref().unwrap_or(endpoint);
        let response = self.http.post(endpoint)
            .json(&json!({"comm":self.comm(desktop,login_type),"req_0":{"module":module,"method":method,"param":param}}))
            .send().await.map_err(|_| "QQ 音乐网络请求失败，请稍后重试")?;
        let body = http::json(response).await?;
        let top = body["code"].as_i64().ok_or("QQ 音乐响应格式不完整")?;
        if top != 0 {
            return Err(format!("{}（代码 {top}）", api_error(top)));
        }
        let code = body["req_0"]["code"]
            .as_i64()
            .ok_or("QQ 音乐响应格式不完整")?;
        if code != 0 {
            return Err(format!("{}（代码 {code}）", api_error(code)));
        }
        if !body["req_0"]["data"].is_object() {
            return Err("QQ 音乐响应缺少数据".into());
        }
        Ok(body["req_0"]["data"].clone())
    }
    pub async fn profile(&self) -> Value {
        let mut result = json!({"userId":self.uin(),"nickname":"QQ 音乐用户","avatar":""});
        let euin = string(&self.credential["encrypt_uin"]);
        if !euin.is_empty() {
            if let Ok(data) = self
                .rpc(
                    "music.UnifiedHomepage.UnifiedHomepageSrv",
                    "GetHomepageHeader",
                    json!({"uin":euin,"IsQueryTabDetail":1}),
                    false,
                    None,
                )
                .await
            {
                let b = &data["Info"]["BaseInfo"];
                if !string(&b["Name"]).is_empty() {
                    result["nickname"] = b["Name"].clone();
                }
                if b["Avatar"].is_string() {
                    result["avatar"] = b["Avatar"].clone();
                }
            }
        }
        result
    }
    pub async fn search(&self, query: &str, offset: u64) -> Result<Value, String> {
        if query.trim().is_empty() || query.len() > 1000 || offset > 1_000_000 {
            return Err("搜索参数无效".into());
        }
        self.rpc(
            "music.search.SearchCgiService",
            "DoSearchForQQMusicDesktop",
            json!({"query":query,"num_per_page":30,"page_num":offset/30+1,"search_type":0}),
            true,
            None,
        )
        .await
    }
    pub async fn detail(&self, id: u64, mid: &str) -> Result<Value, String> {
        let param = if !mid.is_empty() {
            json!({"song_mid":mid})
        } else if id > 0 {
            json!({"song_id":id})
        } else {
            return Err("歌曲信息无效".into());
        };
        let d = self
            .rpc(
                "music.pf_song_detail_svr",
                "get_song_detail_yqq",
                param,
                false,
                None,
            )
            .await?;
        let track = d["track_info"].clone();
        if number(&track["id"]) == 0 || (id > 0 && number(&track["id"]) != id) {
            return Err("无法读取 QQ 歌曲信息".into());
        }
        Ok(track)
    }
    pub async fn lyric(&self, id: u64) -> Result<String, String> {
        // crypt=0 returns ordinary Base64 LRC and avoids the obsolete QRC cipher.
        let d=self.rpc("music.musichallSong.PlayLyricInfo","GetPlayLyricInfo",json!({"songId":id,"crypt":0,"lrc_t":0,"qrc":0,"qrc_t":0,"roma":0,"roma_t":0,"trans":0,"trans_t":0,"needSingingAnnotations":false,"type":1}),false,None).await?;
        let value = string(&d["lyric"]);
        if value.is_empty() {
            return Ok(String::new());
        }
        if value.starts_with('[') {
            return Ok(value.into());
        }
        let bytes = STANDARD.decode(value).map_err(|_| "QQ 歌词格式无法识别")?;
        String::from_utf8(bytes).map_err(|_| "QQ 歌词格式无法识别".into())
    }
    pub async fn created(&self) -> Result<Value, String> {
        self.require_login()?;
        self.rpc(
            "music.musicasset.PlaylistBaseRead",
            "GetPlaylistByUin",
            json!({"uin":self.uin()}),
            false,
            None,
        )
        .await
    }
    pub async fn playback(&self, track: &Value, level: &str) -> Result<Value, String> {
        let levels = levels(level)?;
        let mid = string(&track["mid"]);
        let media = string(&track["file"]["media_mid"]);
        if mid.is_empty() {
            return Err("无法读取 QQ 歌曲信息".into());
        }
        let filenames: Vec<String> = levels
            .iter()
            .map(|quality| {
                let master = string(&track["vs"][3]);
                let media = if *quality == "master" && !master.is_empty() {
                    master
                } else {
                    media
                };
                let media = if media.is_empty() {
                    format!("{mid}{mid}")
                } else {
                    media.into()
                };
                let (prefix, ext) = file_type(quality);
                format!("{prefix}{media}.{ext}")
            })
            .collect();
        let d=self.rpc("music.vkey.GetVkey","UrlGetVkey",json!({"uin":self.uin(),"filename":filenames,"guid":uuid::Uuid::new_v4().simple().to_string(),"songmid":vec![mid;levels.len()],"songtype":vec![number(&track["type"]);levels.len()],"ctx":0}),false,None).await?;
        select_playback(&d, level)
    }
    pub async fn download_info(&self, track: &Value) -> Result<Value, String> {
        self.require_login()?;
        let playback = self.playback(track, "best").await?;
        let lyric = self.lyric(number(&track["id"])).await.unwrap_or_default();
        let artists: Vec<&str> = rows(&track["singer"])
            .iter()
            .map(|a| string(&a["name"]))
            .collect();
        Ok(
            json!({"song":song(track),"artists":artists,"year":string(&track["time_public"]).chars().take(4).collect::<String>(),"playback":playback,"lyric":lyric}),
        )
    }
    pub async fn execute(
        &mut self,
        operation: &str,
        args: &Value,
        pending: &Value,
    ) -> Result<Value, String> {
        let id = number(&args["id"]);
        let offset = number(&args["offset"]);
        let result = match operation {
            "login_qr_start" => return self.start_login(string(&args["kind"])).await,
            "login_qr_check" => return self.check_login(pending).await,
            "account_status" => return self.account().await,
            "search_songs" => {
                let d = self.search(string(&args["query"]), offset).await?;
                let songs: Vec<_> = rows(&d["body"]["song"]["list"]).iter().map(song).collect();
                json!({"total":d["meta"]["sum"].as_u64().unwrap_or(songs.len() as u64),"songs":songs})
            }
            "catalog_search" => {
                let (kind, key) = match string(&args["kind"]) {
                    "artist" => (1, "singer"),
                    "album" => (2, "album"),
                    "playlist" => (3, "songlist"),
                    _ => return Err("不支持的搜索类型".into()),
                };
                let query = string(&args["query"]);
                if query.trim().is_empty() || query.chars().count() > 100 || offset > 10_000 {
                    return Err("请输入 1–100 个字符的搜索词".into());
                }
                let d=self.rpc("music.search.SearchCgiService","DoSearchForQQMusicDesktop",json!({"query":query,"num_per_page":30,"page_num":offset/30+1,"search_type":kind}),true,None).await?;
                let list = rows(&d["body"][key]["list"]);
                let (artists, albums, playlists): (Vec<Value>, Vec<Value>, Vec<Value>) = match kind
                {
                    1 => (list.iter().map(artist_row).collect(), vec![], vec![]),
                    2 => (vec![], list.iter().map(album_row).collect(), vec![]),
                    _ => (vec![], vec![], list.iter().map(songlist_row).collect()),
                };
                let count = list.len() as u64;
                // QQ reports no total for catalog tabs; keep paging while pages are full.
                let total = if count == 30 {
                    offset + count + 1
                } else {
                    offset + count
                };
                json!({"artists":artists,"albums":albums,"playlists":playlists,"total":total})
            }
            "artist_detail" => {
                let mid = valid_mid(string(&args["mid"]))?;
                let info=self.rpc("music.musichallSinger.SingerInfoInter","GetSingerDetail",json!({"singer_mids":[mid],"ex_singer":1,"wiki_singer":0,"group_singer":0,"pic":1,"photos":0}),false,None).await?;
                let singer = rows(&info["singer_list"])
                    .first()
                    .cloned()
                    .ok_or("没有找到这位歌手")?;
                let songs = self
                    .rpc(
                        "musichall.song_list_server",
                        "GetSingerSongList",
                        json!({"singerMid":mid,"order":1,"number":50,"begin":0}),
                        false,
                        None,
                    )
                    .await?;
                let mut artist = artist_row(&singer["basic_info"]);
                artist["alias"] = singer["ex_info"]["foreign_name"].clone();
                artist["songCount"] = json!(number(&songs["totalNum"]));
                let pic = https(string(&singer["pic"]["pic"]));
                if !pic.is_empty() {
                    artist["avatar"] = json!(pic);
                }
                let singer_id = number(&singer["basic_info"]["singer_id"]);
                let similar = match self
                    .rpc(
                        "music.SimilarSingerSvr",
                        "GetSimilarSingerList",
                        json!({"singerId":singer_id,"num":12}),
                        false,
                        None,
                    )
                    .await
                {
                    Ok(d) => rows(&d["singerlist"]).iter().map(artist_row).collect(),
                    Err(_) => Vec::new(),
                };
                json!({"artist":artist,"brief":string(&singer["ex_info"]["desc"]),"songs":rows(&songs["songList"]).iter().map(song).collect::<Vec<_>>(),"similar":similar})
            }
            "artist_albums" => {
                let mid = valid_mid(string(&args["mid"]))?;
                if offset > 10_000 {
                    return Err("专辑参数无效".into());
                }
                let d=self.rpc("music.musichallAlbum.AlbumListServer","GetAlbumList",json!({"singerMid":mid,"order":0,"begin":offset,"num":30,"songNumTag":0,"singerID":0}),false,None).await?;
                let albums: Vec<Value> = rows(&d["albumList"])
                    .iter()
                    .map(|a| {
                        let mut row = album_row(a);
                        row["artistMid"] = json!(mid);
                        row
                    })
                    .collect();
                let total = number(&d["total"]);
                json!({"more":offset + (albums.len() as u64) < total,"total":total,"albums":albums})
            }
            "album_detail" => {
                let mid = valid_mid(string(&args["mid"]))?;
                let info = self
                    .rpc(
                        "music.musichallAlbum.AlbumInfoServer",
                        "GetAlbumDetail",
                        json!({"albumMid":mid}),
                        false,
                        None,
                    )
                    .await?;
                let tracks = self
                    .rpc(
                        "music.musichallAlbum.AlbumSongList",
                        "GetAlbumSongList",
                        json!({"albumMid":mid,"begin":0,"num":200,"order":2}),
                        false,
                        None,
                    )
                    .await?;
                let b = &info["basicInfo"];
                let singers = rows(&info["singer"]["singerList"]);
                let main = singers.first().cloned().unwrap_or(Value::Null);
                let songs: Vec<Value> = rows(&tracks["songList"]).iter().map(song).collect();
                json!({"album":{"source":"qq","id":number(&b["albumID"]),"mid":mid,"name":string(&b["albumName"]),
                    "artist":singers.iter().map(|x| string(&x["name"])).collect::<Vec<_>>().join(" / "),
                    "artistId":number(&main["singerID"]),"artistMid":string(&main["mid"]),"cover":album_cover(mid),
                    "publishTime":date_ms(string(&b["publishDate"])),"trackCount":number(&tracks["totalNum"]).max(songs.len() as u64)},
                    "description":string(&b["desc"]),"songs":songs})
            }
            "my_playlists" => {
                self.require_login()?;
                let mut list = Vec::new();
                if offset == 0 {
                    let d = self.created().await?;
                    list.extend(rows(&d["v_playlist"]).iter().map(|p| playlist(p, true)));
                }
                let euin = string(&self.credential["encrypt_uin"]);
                let uin = self.uin();
                let d=self.rpc("music.musicasset.PlaylistFavRead","CgiGetPlaylistFavInfo",json!({"uin":if euin.is_empty(){&uin}else{euin},"offset":offset/30*30,"size":30}),false,None).await?;
                list.extend(rows(&d["v_list"]).iter().map(|p| playlist(p, false)));
                let mut seen = BTreeSet::new();
                list.retain(|p| number(&p["id"]) > 0 && seen.insert(number(&p["id"])));
                json!({"playlists":list,"more":d["hasmore"]==true||number(&d["hasmore"])!=0,"nextOffset":offset+30})
            }
            "playlist_tracks" => {
                if id == 0 || offset > 1_000_000 {
                    return Err("歌单参数无效".into());
                }
                let d=self.rpc("music.srfDissInfo.DissInfo","CgiGetDiss",json!({"disstid":id,"dirid":number(&args["dirid"]),"tag":1,"song_begin":offset/100*100,"song_num":100,"userinfo":1,"orderlist":1,"onlysonglist":0}),false,None).await?;
                let songs: Vec<_> = rows(&d["songlist"]).iter().map(song).collect();
                json!({"total":d["total_song_num"].as_u64().unwrap_or(songs.len() as u64),"nextOffset":offset+songs.len() as u64,"songs":songs})
            }
            "playlist_edit" => {
                let action = string(&args["action"]);
                let track_id = number(&args["trackId"]);
                if !["add", "remove"].contains(&action) || id == 0 || track_id == 0 {
                    return Err("不支持的歌单操作".into());
                }
                let d = self.created().await?;
                let owned = rows(&d["v_playlist"])
                    .iter()
                    .map(|p| playlist(p, true))
                    .find(|p| number(&p["id"]) == id)
                    .ok_or("只能修改自己创建的歌单")?;
                let track = self.detail(track_id, "").await?;
                let kind = track["type"].as_u64().ok_or("无法读取歌曲类型，请重试")?;
                let d=self.rpc("music.musicasset.PlaylistDetailWrite",if action=="add"{"AddSonglist"}else{"DelSonglist"},json!({"dirId":number(&owned["dirid"]),"tid":id,"bFmtUtf8":true,"v_songInfo":[{"songId":track_id,"songType":kind}]}),false,None).await?;
                if d["retCode"] != 0 {
                    return Err("歌单修改未成功，请刷新后重试".into());
                }
                Value::Null
            }
            "song_lyric" => json!(self.lyric(id).await?),
            "song_url" => {
                let track = self.detail(id, string(&args["mid"])).await?;
                let level = args["level"].as_str().unwrap_or("standard");
                self.playback(&track, level).await?
            }
            "download_info" => {
                self.require_login()?;
                let track = self.detail(id, "").await?;
                self.download_info(&track).await?
            }
            "download_match" => {
                self.require_login()?;
                let wanted = &args["song"];
                if rows(&wanted["artists"]).is_empty() || string(&wanted["name"]).is_empty() {
                    return Err("无法读取原歌曲匹配信息".into());
                }
                let d = self
                    .search(
                        &format!(
                            "{} {}",
                            string(&wanted["name"]),
                            string(&wanted["artists"][0])
                        ),
                        0,
                    )
                    .await?;
                let ids: BTreeSet<_> = rows(&d["body"]["song"]["list"])
                    .iter()
                    .filter(|t| number(&t["id"]) > 0 && same_recording(t, wanted))
                    .map(|t| number(&t["id"]))
                    .collect();
                if ids.len() != 1 {
                    return Err(
                        "QQ 音乐未找到唯一同版本音源（歌名、歌手、专辑、时长须一致）".into(),
                    );
                }
                let track = self.detail(*ids.first().unwrap(), "").await?;
                if !same_recording(&track, wanted) {
                    return Err("QQ 音乐未找到与原歌曲一致的完整版本".into());
                }
                self.download_info(&track).await?
            }
            _ => return Err("不支持的 QQ 操作".into()),
        };
        Ok(json!({"result":result}))
    }
}
pub(super) fn api_error(code: i64) -> String {
    match code {
        1000 | 104401 | 104400 => "QQ 登录已过期，请重新扫码",
        2001 | 104604 => "QQ 音乐请求过于频繁，请稍后重试",
        20279 => "QQ 登录设备数量已达上限",
        _ => "QQ 音乐暂时无法完成请求，请检查网络或重新登录",
    }
    .into()
}
fn first<'a>(p: &'a Value, keys: &[&str]) -> &'a Value {
    keys.iter()
        .map(|key| &p[*key])
        .find(|v| !v.is_null() && **v != 0 && **v != "")
        .unwrap_or(&Value::Null)
}
fn playlist(p: &Value, owned: bool) -> Value {
    json!({"id":number(first(p,&["tid","id","dissid"])),"source":"qq","dirid":number(first(p,&["dirId","dirid"])),"name":first(p,&["title","dirName","dissname"]).as_str().unwrap_or("歌单"),"cover":string(first(p,&["picurl","picUrl","cover"])).replacen("http://","https://",1),"trackCount":number(first(p,&["songnum","songNum","song_cnt"])),"creator":first(p,&["nick","nickname"]).as_str().unwrap_or("QQ 音乐"),"owned":owned})
}
fn song(s: &Value) -> Value {
    // Singer / album lists wrap each track as {songInfo: …}.
    let s = if s["songInfo"].is_object() {
        &s["songInfo"]
    } else {
        s
    };
    let singers = rows(&s["singer"]);
    let artists: Vec<_> = singers.iter().map(|a| string(&a["name"])).collect();
    let refs: Vec<_> = singers
        .iter()
        .map(|a| json!({"id":number(&a["id"]),"mid":string(&a["mid"]),"name":string(&a["name"])}))
        .collect();
    let mid = string(&s["album"]["mid"]);
    json!({"id":number(&s["id"]),"source":"qq","mid":s["mid"],"name":first(s,&["title","name"]),"artist":artists.join(" / "),"artists":refs,"album":s["album"]["name"].as_str().unwrap_or(""),"albumId":number(&s["album"]["id"]),"albumMid":mid,"gain":s["volume"]["gain"].as_f64().filter(|g| g.is_finite() && (-30.0..=20.0).contains(g)),"quality":if number(&s["file"]["size_hires"])>0{"hires"}else if number(&s["file"]["size_flac"])>0{"lossless"}else{""},"cover":album_cover(mid),"duration":number(&s["interval"])*1000,"fee":if number(&s["pay"]["pay_play"])>0{1}else{0}})
}
fn album_cover(mid: &str) -> String {
    if mid.is_empty() {
        String::new()
    } else {
        format!("https://y.gtimg.cn/music/photo_new/T002R300x300M000{mid}.jpg")
    }
}
fn singer_avatar(mid: &str) -> String {
    if mid.is_empty() {
        String::new()
    } else {
        format!("https://y.gtimg.cn/music/photo_new/T001R300x300M000{mid}.jpg")
    }
}
fn https(s: &str) -> String {
    s.replacen("http://", "https://", 1)
}
fn artist_row(a: &Value) -> Value {
    let mid = string(first(a, &["singerMID", "singerMid", "singer_mid", "mid"]));
    json!({"source":"qq","id":number(first(a,&["singerID","singerId","singer_id","id"])),"mid":mid,"name":string(first(a,&["singerName","name"])),"avatar":singer_avatar(mid),"albumCount":number(&a["albumNum"]),"songCount":number(&a["songNum"]),"alias":string(first(a,&["foreign_name","singerTransName"]))})
}
fn album_row(a: &Value) -> Value {
    let mid = string(first(a, &["albumMID", "albumMid"]));
    let singers = rows(&a["singer_list"]);
    let artist = if singers.is_empty() {
        string(&a["singerName"]).to_owned()
    } else {
        singers
            .iter()
            .map(|x| string(&x["name"]))
            .collect::<Vec<_>>()
            .join(" / ")
    };
    let date = string(first(a, &["publicTime", "publishDate"]));
    json!({"source":"qq","id":number(first(a,&["albumID","albumId"])),"mid":mid,"name":string(first(a,&["albumName","name"])),"artist":artist,"artistId":number(&a["singerID"]),"artistMid":string(&a["singerMID"]),"cover":album_cover(mid),"publishTime":date_ms(date),"trackCount":number(first(a,&["song_count","totalNum"]))})
}
/// "2003-07-31" as Unix milliseconds (UTC midnight); 0 when unparseable.
fn date_ms(date: &str) -> u64 {
    // "2003-07-31", possibly followed by a time ("2003-07-31 00:00:00").
    let day = date.split([' ', 'T']).next().unwrap_or("");
    let parts: Vec<i64> = day.split('-').filter_map(|p| p.parse().ok()).collect();
    let [y, m, d] = parts[..] else { return 0 };
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || !(1900..=9999).contains(&y) {
        return 0;
    }
    // Days from civil (Howard Hinnant).
    let (y, m) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * m + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    ((era * 146097 + doe - 719468) * 86_400_000).max(0) as u64
}
fn songlist_row(p: &Value) -> Value {
    json!({"source":"qq","id":number(&p["dissid"]),"name":string(&p["dissname"]),"cover":https(string(&p["imgurl"])),"trackCount":number(&p["song_count"]),"creator":string(&p["creator"]["name"]),"owned":false})
}
fn valid_mid(mid: &str) -> Result<&str, String> {
    if mid.is_empty() || mid.len() > 32 || !mid.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("QQ 音乐标识无效".into());
    }
    Ok(mid)
}
fn levels(level: &str) -> Result<&'static [&'static str], String> {
    match level {
        "standard" => Ok(&["standard"]),
        "exhigh" => Ok(&["exhigh", "standard"]),
        "lossless" => Ok(&["lossless", "exhigh", "standard"]),
        "best" => Ok(&["master", "lossless", "exhigh", "standard"]),
        _ => Err("音质参数无效".into()),
    }
}
fn file_type(level: &str) -> (&'static str, &'static str) {
    match level {
        "master" => ("AI00", "flac"),
        "lossless" => ("F000", "flac"),
        "exhigh" => ("M800", "mp3"),
        _ => ("M500", "mp3"),
    }
}
fn select_playback(d: &Value, requested: &str) -> Result<Value, String> {
    for level in levels(requested)? {
        let (prefix, format) = file_type(level);
        for row in rows(&d["midurlinfo"]) {
            let purl = string(&row["purl"]);
            if purl.is_empty() || row.get("result").is_some_and(|v| *v != 0) {
                continue;
            }
            let url = reqwest::Url::parse("https://isure.stream.qqmusic.qq.com/")
                .unwrap()
                .join(purl)
                .map_err(|_| "音源地址无效")?;
            if !url
                .path()
                .rsplit('/')
                .next()
                .unwrap_or("")
                .starts_with(prefix)
            {
                continue;
            }
            if url.scheme() != "https"
                || !url.host_str().is_some_and(|h| h.ends_with(".qq.com"))
                || !url.username().is_empty()
                || url.password().is_some()
                || url.port_or_known_default() != Some(443)
            {
                return Err("音源地址不安全".into());
            }
            return Ok(
                json!({"url":url.as_str(),"trial":false,"trialStart":0,"level":level,"requestedLevel":requested,"bitrate":match *level{"standard"=>128000,"exhigh"=>320000,_=>0},"format":format}),
            );
        }
    }
    Err("QQ 音乐未返回可播放音源，请检查登录、会员权限或歌曲版权".into())
}
fn normalized(s: &str) -> String {
    s.nfkc()
        .case_fold()
        .filter(|c| c.is_alphanumeric())
        .collect()
}
fn same_recording(track: &Value, wanted: &Value) -> bool {
    let expected: BTreeSet<_> = rows(&wanted["artists"])
        .iter()
        .map(|a| normalized(string(a)))
        .filter(|s| !s.is_empty())
        .collect();
    let actual: BTreeSet<_> = rows(&track["singer"])
        .iter()
        .map(|a| normalized(string(&a["name"])))
        .filter(|s| !s.is_empty())
        .collect();
    let album = normalized(string(&track["album"]["name"]));
    let duration = number(&track["interval"]) * 1000;
    let wanted_duration = number(&wanted["duration"]);
    let version=regex::Regex::new(r"(?i)(\blive\b|\bremix\b|\bremaster\w*\b|\bacoustic\b|\binstrumental\b|\bversion\b|现场|伴奏|翻唱|重制|纯音乐|混音|演唱会)").unwrap();
    !expected.is_empty()
        && actual == expected
        && !album.is_empty()
        && album == normalized(string(&wanted["album"]))
        && normalized(string(first(track, &["title", "name"])))
            == normalized(string(&wanted["name"]))
        && duration > 0
        && wanted_duration > 0
        && duration.abs_diff(wanted_duration) <= 2000
        && !version.is_match(string(&track["subtitle"]))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn track() -> Value {
        json!({"id":123,"mid":"mid","title":"Song","singer":[{"name":"Artist"}],"album":{"name":"Album","mid":"album"},"interval":20,"type":0})
    }
    fn wanted() -> Value {
        json!({"name":"Song","artists":["Artist"],"album":"Album","duration":20000})
    }
    #[test]
    fn credentials_accept_legacy_and_upstream_aliases() {
        for c in [
            json!({"musicid":123,"musickey":"fixture","login_type":2,"encrypt_uin":"uin"}),
            json!({"musicid":123,"musickey":"fixture","loginType":2,"encryptUin":"uin"}),
        ] {
            let c = normalize_credential(c).unwrap();
            assert_eq!(c["login_type"], 2);
            assert_eq!(c["encrypt_uin"], "uin");
        }
        assert!(normalize_credential(json!({"musicid":0,"musickey":"fixture"})).is_err());
    }
    #[test]
    fn member_authentication_is_present_on_both_platforms() {
        let c = Client::new(
            json!({"musicid":123,"musickey":"test-session","login_type":1}),
            "guid".into(),
        )
        .unwrap();
        for desktop in [false, true] {
            let comm = c.comm(desktop, None);
            assert_eq!(comm["authst"], "test-session");
            assert_eq!(comm["tmeLoginType"], 1);
            assert_eq!(comm["uin"], 123);
            assert_eq!(comm["g_tk"], hash33("test-session", 5381));
        }
    }
    #[test]
    fn playback_selects_quality_not_row_order() {
        let d = json!({"midurlinfo":[{"purl":"M500test.mp3","result":0},{"purl":"F000test.flac","result":0},{"purl":"AI00test.flac","result":0}]});
        assert_eq!(select_playback(&d, "best").unwrap()["level"], "master");
        assert_eq!(
            select_playback(&d, "lossless").unwrap()["level"],
            "lossless"
        );
        assert_eq!(select_playback(&d, "exhigh").unwrap()["level"], "standard");
        assert!(select_playback(&d, "invalid").is_err());
    }
    #[test]
    fn playback_rejects_foreign_and_insecure_urls() {
        for url in [
            "https://qq.com.evil.example/F000x.flac",
            "http://stream.qqmusic.qq.com/F000x.flac",
            "https://user:pass@stream.qqmusic.qq.com/F000x.flac",
            "https://stream.qqmusic.qq.com:444/F000x.flac",
        ] {
            assert!(select_playback(&json!({"midurlinfo":[{"purl":url}]}), "lossless").is_err());
        }
    }
    #[test]
    fn playback_rejects_missing_or_denied_sources() {
        for d in [
            json!({}),
            json!({"midurlinfo":[{"purl":"","result":0}]}),
            json!({"midurlinfo":[{"purl":"F000x.flac","result":104400}]}),
        ] {
            assert!(select_playback(&d, "best").is_err());
        }
    }
    #[test]
    fn song_and_playlist_contracts() {
        let t = song(&track());
        assert_eq!(t["duration"], 20000);
        assert_eq!(t["source"], "qq");
        let p = playlist(
            &json!({"tid":"12","dirId":201,"dirName":"Favorites","songNum":50}),
            true,
        );
        assert_eq!(p["id"], 12);
        assert_eq!(p["dirid"], 201);
        assert_eq!(p["owned"], true);
        assert_eq!(p["trackCount"], 50);
    }
    #[test]
    fn catalog_rows_and_dates() {
        assert_eq!(date_ms("1970-01-02"), 86_400_000);
        assert_eq!(date_ms("2003-07-31"), 1_059_609_600_000);
        assert_eq!(date_ms("bad"), 0);
        assert_eq!(date_ms("2003-07-31 12:00:00"), 1_059_609_600_000);
        assert_eq!(date_ms("99999999999999-01-01"), 0);
        let a = artist_row(
            &json!({"singerID":4558,"singerMID":"0025NhlN2yWrP4","singerName":"周杰伦","albumNum":43,"songNum":1012}),
        );
        assert_eq!(a["mid"], "0025NhlN2yWrP4");
        assert!(a["avatar"]
            .as_str()
            .unwrap()
            .contains("T001R300x300M0000025NhlN2yWrP4"));
        let al = album_row(
            &json!({"albumID":8220,"albumMID":"000MkMni19ClKG","albumName":"叶惠美","singer_list":[{"name":"周杰伦"}],"publicTime":"2003-07-31","song_count":11}),
        );
        assert_eq!(al["trackCount"], 11);
        assert_eq!(al["artist"], "周杰伦");
        let wrapped = song(
            &json!({"songInfo":{"id":1,"mid":"m","title":"晴天","singer":[{"id":4558,"mid":"s","name":"周杰伦"}],"album":{"id":8220,"mid":"a","name":"叶惠美"},"interval":10}}),
        );
        assert_eq!(wrapped["albumMid"], "a");
        assert_eq!(wrapped["artists"][0]["mid"], "s");
        assert!(valid_mid("abc/../x").is_err());
    }
    #[tokio::test]
    #[ignore = "public read-only QQ catalog smoke test"]
    async fn live_qq_catalog() {
        let mut c = Client::new(Value::Null, "1234567890".into()).unwrap();
        let none = Value::Null;
        let found = c
            .execute(
                "catalog_search",
                &json!({"query":"周杰伦","kind":"artist"}),
                &none,
            )
            .await
            .unwrap()["result"]
            .take();
        let mid = found["artists"][0]["mid"].as_str().unwrap().to_owned();
        let page = c
            .execute("artist_detail", &json!({"mid":mid}), &none)
            .await
            .unwrap()["result"]
            .take();
        assert!(!rows(&page["songs"]).is_empty());
        assert!(!rows(&page["similar"]).is_empty(), "similar singers");
        assert!(
            !string(&page["similar"][0]["mid"]).is_empty()
                && !string(&page["similar"][0]["name"]).is_empty()
        );
        let albums = c
            .execute("artist_albums", &json!({"mid":mid}), &none)
            .await
            .unwrap()["result"]
            .take();
        let album = albums["albums"][0]["mid"].as_str().unwrap().to_owned();
        let detail = c
            .execute("album_detail", &json!({"mid":album}), &none)
            .await
            .unwrap()["result"]
            .take();
        assert!(!rows(&detail["songs"]).is_empty());
        for kind in ["album", "playlist"] {
            let r = c
                .execute(
                    "catalog_search",
                    &json!({"query":"周杰伦","kind":kind}),
                    &none,
                )
                .await
                .unwrap()["result"]
                .take();
            assert!(
                !rows(
                    &r[if kind == "album" {
                        "albums"
                    } else {
                        "playlists"
                    }]
                )
                .is_empty(),
                "{kind}"
            );
        }
        eprintln!(
            "{} · {} songs · {} albums · {} tracks",
            page["artist"]["name"],
            rows(&page["songs"]).len(),
            albums["total"],
            rows(&detail["songs"]).len()
        );
    }
    #[test]
    fn fallback_requires_complete_recording_identity() {
        assert!(same_recording(&track(), &wanted()));
        for patch in [
            json!({"album":"Other"}),
            json!({"artists":["Artist","Other"]}),
            json!({"duration":25000}),
            json!({"name":"Song (Live)"}),
            json!({"album":""}),
            json!({"artists":[]}),
        ] {
            let mut w = wanted();
            w.as_object_mut()
                .unwrap()
                .extend(patch.as_object().unwrap().clone());
            assert!(!same_recording(&track(), &w));
        }
    }
    #[test]
    fn fallback_rejects_version_subtitles() {
        for subtitle in ["Live", "2026 Remaster", "instrumental", "现场版", "混音"] {
            let mut t = track();
            t["subtitle"] = json!(subtitle);
            assert!(!same_recording(&t, &wanted()));
        }
    }
    #[test]
    fn unicode_identity_normalization_matches_previous_casefold() {
        assert_eq!(normalized("Ａ rt_ist"), "artist");
        assert_eq!(normalized("Straße"), "strasse");
    }
    #[tokio::test]
    #[ignore = "public read-only QQ API smoke test; no account loaded"]
    async fn live_public_search_detail_lyrics_and_qr() {
        let mut c = Client::new(Value::Null, "1234567890".into()).unwrap();
        let data = c.search("周杰伦 红尘客栈", 0).await.unwrap();
        let t = rows(&data["body"]["song"]["list"])
            .iter()
            .find(|t| string(&t["title"]) == "红尘客栈")
            .expect("expected song in search");
        let t = c.detail(number(&t["id"]), "").await.unwrap();
        assert!(!c.lyric(number(&t["id"])).await.unwrap().is_empty());
        for kind in ["qq", "wx"] {
            let qr = c.start_login(kind).await.unwrap();
            assert!(string(&qr["result"]["image"]).starts_with("data:image/"));
            assert_eq!(
                c.check_login(&qr["pending"]).await.unwrap()["result"]["code"],
                801
            );
        }
    }
    #[tokio::test]
    #[ignore = "read-only membership regression using this Mac's existing Keychain; never prints credentials or URLs"]
    async fn live_saved_member_quality() {
        let saved = super::super::load().expect("saved QQ session required");
        let c = Client::new(saved, uuid::Uuid::new_v4().simple().to_string()).unwrap();
        let data = c.search("周杰伦 红尘客栈", 0).await.unwrap();
        let t = rows(&data["body"]["song"]["list"])
            .iter()
            .find(|t| {
                string(&t["title"]) == "红尘客栈"
                    && rows(&t["singer"])
                        .iter()
                        .any(|s| string(&s["name"]) == "周杰伦")
            })
            .expect("expected recording");
        let t = c.detail(number(&t["id"]), "").await.unwrap();
        let playback = c.playback(&t, "lossless").await.unwrap();
        assert!(
            playback["level"] == "lossless",
            "member lossless unavailable"
        );
        let created = c.created().await.unwrap();
        assert!(created["v_playlist"].is_array());
    }
    #[tokio::test]
    #[ignore = "live QQ member download into a disposable test directory; no credentials or URLs printed"]
    async fn live_qq_native_download() {
        let saved = super::super::load().expect("saved QQ session required");
        let c = Client::new(saved, uuid::Uuid::new_v4().simple().to_string()).unwrap();
        let data = c.search("周杰伦 红尘客栈", 0).await.unwrap();
        let track = rows(&data["body"]["song"]["list"])
            .iter()
            .find(|t| {
                string(&t["title"]) == "红尘客栈"
                    && rows(&t["singer"])
                        .iter()
                        .any(|v| string(&v["name"]) == "周杰伦")
            })
            .expect("expected recording");
        let id = number(&track["id"]);
        let track = c.detail(id, "").await.unwrap();
        let info = c.download_info(&track).await.unwrap();
        assert_eq!(info["playback"]["format"], "flac");
        let folder = crate::download::Scratch(
            std::env::temp_dir().join(format!("ting-live-{}", uuid::Uuid::new_v4())),
        );
        std::fs::create_dir(&folder.0).unwrap();
        let scratch = crate::download::Scratch(folder.0.join("scratch"));
        std::fs::create_dir(&scratch.0).unwrap();
        let result = crate::download_engine::run(
            id,
            "qq".into(),
            info,
            Value::Null,
            folder.0.clone(),
            scratch,
            crate::download::Guard::for_test(),
        )
        .await
        .unwrap();
        let path = std::path::PathBuf::from(result["path"].as_str().unwrap());
        assert!(path.is_file());
        assert_eq!(result["format"], "flac");
        assert!(result["bytes"].as_u64().unwrap() > 1_000_000);
        let provenance: Value =
            serde_json::from_slice(&std::fs::read(path.with_extension("json")).unwrap()).unwrap();
        assert_eq!(provenance["origin"]["id"], id);
        assert_eq!(provenance["audio"]["platform"], "qq");
        assert!(provenance.get("url").is_none());
        assert!(!folder.0.join("scratch").exists());
    }

    fn mock_client(
        responses: Vec<Value>,
    ) -> (
        Client,
        std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
        std::thread::JoinHandle<()>,
    ) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = requests.clone();
        let task = std::thread::spawn(move || {
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(10)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut chunk = [0; 4096];
                let header_end = loop {
                    let n = stream.read(&mut chunk).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&chunk[..n]);
                    if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                        break end + 4;
                    }
                };
                let headers = String::from_utf8_lossy(&bytes[..header_end]);
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse().unwrap())
                    })
                    .unwrap();
                while bytes.len() < header_end + length {
                    let n = stream.read(&mut chunk).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&chunk[..n]);
                }
                captured
                    .lock()
                    .unwrap()
                    .push(serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap());
                let body = response.to_string();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
            }
        });
        let mut c = Client::new(
            json!({"musicid":123,"musickey":"fixture-session","login_type":2}),
            uuid::Uuid::new_v4().simple().to_string(),
        )
        .unwrap();
        c.rpc_endpoint = Some(format!("http://{addr}/rpc"));
        (c, requests, task)
    }
    fn ok(data: Value) -> Value {
        json!({"code":0,"req_0":{"code":0,"data":data}})
    }
    #[tokio::test]
    async fn playlist_write_verifies_ownership_and_server_song_type() {
        let mut t = track();
        t["type"] = json!(111);
        let (mut c, requests, server) = mock_client(vec![
            ok(json!({"v_playlist":[{"tid":456,"dirId":201}]})),
            ok(json!({"track_info":t})),
            ok(json!({"retCode":0})),
        ]);
        let r = c
            .execute(
                "playlist_edit",
                &json!({"id":456,"trackId":123,"action":"add","dirid":999,"songType":999}),
                &Value::Null,
            )
            .await
            .unwrap();
        assert!(r["result"].is_null());
        server.join().unwrap();
        let requests = requests.lock().unwrap();
        let write = &requests[2]["req_0"];
        assert_eq!(write["method"], "AddSonglist");
        assert_eq!(write["param"]["dirId"], 201);
        assert_eq!(write["param"]["bFmtUtf8"], true);
        assert_eq!(
            write["param"]["v_songInfo"],
            json!([{"songId":123,"songType":111}])
        );
    }
    #[tokio::test]
    async fn read_only_playlist_is_rejected_before_any_write() {
        let (mut c, requests, server) = mock_client(vec![ok(json!({"v_playlist":[]}))]);
        assert!(c
            .execute(
                "playlist_edit",
                &json!({"id":456,"trackId":123,"action":"remove"}),
                &Value::Null
            )
            .await
            .unwrap_err()
            .contains("自己创建"));
        server.join().unwrap();
        assert_eq!(requests.lock().unwrap().len(), 1);
    }
    #[tokio::test]
    async fn playlist_listing_deduplicates_owned_and_favorites() {
        let (mut c, requests, server) = mock_client(vec![
            ok(json!({"v_playlist":[{"tid":1,"dirId":201}]})),
            ok(json!({"v_list":[{"tid":1},{"tid":2}],"hasmore":1})),
        ]);
        let result = c
            .execute("my_playlists", &json!({"offset":0}), &Value::Null)
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(rows(&result["result"]["playlists"]).len(), 2);
        assert_eq!(result["result"]["playlists"][0]["owned"], true);
        assert_eq!(result["result"]["more"], true);
        assert_eq!(requests.lock().unwrap()[1]["req_0"]["param"]["size"], 30);
    }
    #[tokio::test]
    async fn ambiguous_fallback_is_rejected_without_resolving_urls() {
        let mut other = track();
        other["id"] = json!(124);
        let (mut c, requests, server) =
            mock_client(vec![ok(json!({"body":{"song":{"list":[track(),other]}}}))]);
        assert!(c
            .execute("download_match", &json!({"song":wanted()}), &Value::Null)
            .await
            .unwrap_err()
            .contains("唯一"));
        server.join().unwrap();
        assert_eq!(requests.lock().unwrap().len(), 1);
    }
    #[tokio::test]
    async fn rpc_errors_are_redacted_and_malformed_responses_fail_closed() {
        for response in [
            json!({"code":0,"req_0":{"code":1000,"data":{"message":"authst=DO_NOT_EXPOSE"}}}),
            json!({"code":0,"req_0":{"data":{"secret":"DO_NOT_EXPOSE"}}}),
            json!({"code":0,"req_0":{"code":0,"data":null}}),
        ] {
            let (c, _, server) = mock_client(vec![response]);
            let error = c.search("fixture", 0).await.unwrap_err();
            assert!(!error.contains("DO_NOT_EXPOSE"));
            server.join().unwrap();
        }
    }
    #[tokio::test]
    async fn vkey_uses_full_guid_media_mid_and_song_type() {
        let (c, requests, server) = mock_client(vec![ok(
            json!({"midurlinfo":[{"purl":"F000media.flac","result":0}]}),
        )]);
        let mut t = track();
        t["file"] = json!({"media_mid":"media"});
        t["type"] = json!(111);
        assert_eq!(
            c.playback(&t, "lossless").await.unwrap()["level"],
            "lossless"
        );
        server.join().unwrap();
        let requests = requests.lock().unwrap();
        let p = &requests[0]["req_0"]["param"];
        assert_eq!(string(&p["guid"]).len(), 32);
        assert_eq!(p["filename"][0], "F000media.flac");
        assert_eq!(p["songtype"][0], 111);
        assert_eq!(p["uin"], "123");
    }
}
