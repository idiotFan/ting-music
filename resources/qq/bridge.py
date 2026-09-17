"""One-shot QQ adapter. Secrets arrive over stdin and are stripped by Rust before IPC."""
import sys, json, asyncio, base64, os, re, unicodedata
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent / 'vendor'))
from qqmusic_api import Client, Platform
from qqmusic_api.models.request import Credential
from qqmusic_api.models.login import QR, QRLoginType
from qqmusic_api.modules.song import SongFileInfo, SongFileType

class QqError(ValueError):
    """Application-owned public errors, never arbitrary upstream exception strings."""


def public_error(error):
    if isinstance(error, QqError):
        return str(error)
    kind = type(error).__name__
    if 'Ratelimit' in kind:
        return 'QQ 音乐请求过于频繁，请稍后重试'
    if 'LoginAuth' in kind:
        return 'QQ 登录已过期，请重新扫码'
    if 'Timeout' in kind:
        return 'QQ 音乐网络请求超时，请稍后重试'
    return 'QQ 音乐暂时无法完成请求，请检查网络或重新登录'


async def raw(req):
    req.disable_parse = True
    return await req

def song(s):
    album = s.get('album') or {}
    return dict(id=int(s['id']), source='qq', mid=s['mid'], name=s.get('title') or s.get('name',''),
        artist=' / '.join(x.get('name','') for x in s.get('singer',[])), album=album.get('name',''),
        cover=f"https://y.gtimg.cn/music/photo_new/T002R300x300M000{album['mid']}.jpg" if album.get('mid') else '',
        duration=int(s.get('interval',0))*1000, fee=1 if (s.get('pay') or {}).get('pay_play') else 0)

def playlist(p, owned):
    return dict(id=int(p.get('tid') or p.get('id') or p.get('dissid') or 0), source='qq', dirid=p.get('dirId',p.get('dirid',0)),
        name=p.get('title') or p.get('dirName') or p.get('dissname') or '歌单',
        cover=(p.get('picurl') or p.get('picUrl') or p.get('cover') or '').replace('http://','https://'),
        trackCount=p.get('songnum',p.get('songNum',p.get('song_cnt',0))),creator=p.get('nick') or p.get('nickname') or 'QQ 音乐',owned=owned)

async def profile(c):
    cr=c.credential
    nickname='QQ 音乐用户';avatar=''
    if cr.encrypt_uin:
        try:
            h=await raw(c.user.get_homepage(cr.encrypt_uin)); b=h.get('Info',{}).get('BaseInfo',{})
            nickname=b.get('Name') or nickname;avatar=b.get('Avatar') or ''
        except Exception: pass
    return dict(userId=str(cr.musicid), nickname=nickname, avatar=avatar)

def normalized(value):
    return re.sub(r"[\W_]", "", unicodedata.normalize("NFKC", str(value or "")).casefold())


def same_recording(track, wanted):
    """Conservative automatic fallback: never guess live/remix/cover/album variants."""
    expected_artists = {normalized(name) for name in wanted.get('artists', []) if normalized(name)}
    artists = {normalized(item.get('name')) for item in track.get('singer', []) if normalized(item.get('name'))}
    title = normalized(track.get('title') or track.get('name'))
    album = normalized((track.get('album') or {}).get('name'))
    subtitle = str(track.get('subtitle') or '')
    version_markers = r'(?i)(?:\blive\b|\bremix\b|\bremaster(?:ed)?\b|\bacoustic\b|\binstrumental\b|\bversion\b|现场|伴奏|翻唱|重制|纯音乐|混音|演唱会)'
    if re.search(version_markers, subtitle):
        return False
    return (bool(title) and title == normalized(wanted.get('name'))
            and bool(expected_artists) and artists == expected_artists
            and bool(album) and album == normalized(wanted.get('album'))
            and wanted.get('duration', 0) > 0 and track.get('interval', 0) > 0
            and abs(track['interval'] * 1000 - wanted['duration']) <= 2000)


async def search_tracks(c, query, offset=0):
    req = c.search.search_by_type(query, num=30, page=offset // 30 + 1, highlight=False)
    req.platform = Platform.DESKTOP
    req.method = "DoSearchForQQMusicDesktop"
    req.param = {"query": query, "num_per_page": 30, "page_num": offset // 30 + 1, "search_type": 0}
    return await raw(req)


async def download_info(c, track):
    audio = (await playback(c, {'id': track['id'], 'level': 'best'}, track))['result']
    lyric = ''
    try:
        lyric = (await c.lyric.get_lyric(int(track['id']))).lyric
    except Exception:
        pass
    return {'song': song(track), 'artists': [v['name'] for v in track.get('singer', [])],
            'year': str(track.get('time_public', ''))[:4], 'playback': audio, 'lyric': lyric}


async def playback(c,a,track=None):
    if track is None:
        d=await raw(c.song.get_detail(a.get('mid') or int(a['id'])))
        track=d.get('track_info') or {}
    mid=track.get('mid');media=track.get('file',{}).get('media_mid')
    if not mid: raise QqError('无法读取 QQ 歌曲信息')
    level=a.get('level','standard')
    levels={'standard':['standard'],'exhigh':['exhigh','standard'],'lossless':['lossless','exhigh','standard'],'best':['master','lossless','exhigh','standard']}.get(level,['standard'])
    types={'master':SongFileType.MASTER,'lossless':SongFileType.FLAC,'exhigh':SongFileType.MP3_320,'standard':SongFileType.MP3_128}
    variants=track.get('vs') or []
    master_mid=variants[3] if len(variants)>3 and isinstance(variants[3],str) and variants[3] else media
    info=[SongFileInfo(mid=mid,media_mid=master_mid if l=='master' else media,song_type=track.get('type',0),file_type=types[l]) for l in levels]
    req=c.song.get_song_urls(info)
    req.param['uin']=c.credential.str_musicid or str(c.credential.musicid)
    urls=await raw(req)
    # Select by requested quality priority, not by upstream row order.
    prefixes={types[l].s:l for l in levels}
    rows=sorted(urls.get('midurlinfo',[]),key=lambda row:levels.index(prefixes[row.get('filename','')[:4]]) if row.get('filename','')[:4] in prefixes else len(levels))
    for row in rows:
        purl=row.get('purl','')
        if not purl or row.get('result',0)!=0: continue
        from urllib.parse import urlparse
        prefix=urlparse(purl).path.rsplit('/',1)[-1][:4]
        l={'AI00':'master','F000':'lossless','M800':'exhigh','M500':'standard'}.get(prefix)
        if l not in levels: continue
        from urllib.parse import urljoin,urlparse
        url=urljoin('https://isure.stream.qqmusic.qq.com/',purl)
        host=urlparse(url).hostname or ''
        if not (host.endswith('.qq.com') or host.endswith('.qqmusic.qq.com')): raise QqError('音源地址不受支持')
        if urlparse(url).scheme!='https': raise QqError('音源地址不安全')
        return {'result':dict(url=url,trial=False,trialStart=0,level=l,requestedLevel=level,bitrate={'standard':128000,'exhigh':320000}.get(l,0),format='flac' if l in ('master','lossless') else 'mp3')}
    raise QqError('QQ 音乐未返回可播放音源，请检查登录、会员权限或歌曲版权')

async def main(r):
    op=r['operation'];a=r.get('args') or {};saved=r.get('credential')
    if op=='account_status' and not saved: return {'result':None}
    os.umask(0o077)
    async with Client(credential=Credential.model_validate(saved or {}),platform=Platform.WEB,device_path=r['devicePath']) as c:
        if op=='login_qr_start':
            kind=a.get('kind','qq')
            if kind not in ('qq','wx'): raise QqError('登录类型无效')
            qr=await c.login.get_qrcode(QRLoginType(kind))
            return {'result':{'image':'data:'+qr.mimetype+';base64,'+base64.b64encode(qr.data).decode()},'pending':{'type':kind,'identifier':qr.identifier}}
        if op=='login_qr_check':
            p=r.get('pending')
            if not p: return {'result':{'code':800}}
            qr=QR(b'',QRLoginType(p['type']),'image/png',p['identifier'])
            check=await c.login.check_qrcode(qr)
            if check.done:
                c.credential=check.credential
                return {'result':{'code':803,'profile':await profile(c)},'credential':check.credential.model_dump(mode='json')}
            return {'result':{'code':{'SCAN':801,'CONF':802,'TIMEOUT':800,'REFUSE':804}.get(check.event.name,800)}}
        if op=='account_status':
            if await c.login.check_expired():
                try: c.credential=await c.login.refresh_credential()
                except Exception: return {'result':None,'expired':True}
            return {'result':await profile(c),'credential':c.credential.model_dump(mode='json')}
        if op=='search_songs':
            d=await search_tracks(c,a['query'],int(a.get('offset',0)))
            body=d.get('body',{}).get('song',{});items=body.get('list',[])
            return {'result':{'songs':[song(s) for s in items], 'total':d.get('meta',{}).get('sum',len(items))}}
        if op=='my_playlists':
            if not saved: raise QqError('请先登录 QQ 音乐')
            offset=int(a.get('offset',0));items=[]
            if offset==0:
                created=await raw(c.user.get_created_songlist(c.credential.musicid))
                items=[playlist(p,True) for p in created.get('v_playlist',[])]
            fav=await raw(c.user.get_fav_songlist(c.credential.encrypt_uin or str(c.credential.musicid),page=offset//30+1,num=30))
            items += [playlist(p,False) for p in fav.get('v_list',[])]
            seen=set();items=[p for p in items if p['id'] and not (p['id'] in seen or seen.add(p['id']))]
            return {'result':{'playlists':items,'more':bool(fav.get('hasmore')),'nextOffset':offset+30}}
        if op=='playlist_edit':
            if not saved: raise QqError('请先登录 QQ 音乐')
            action=a.get('action');tid=int(a['id']);track_id=int(a['trackId'])
            if action not in ('add','remove') or tid<=0 or track_id<=0:
                raise QqError('不支持的歌单操作')
            created=await raw(c.user.get_created_songlist(c.credential.musicid))
            owned=next((p for p in created.get('v_playlist',[]) if playlist(p,True)['id']==tid),None)
            if owned is None: raise QqError('只能修改自己创建的歌单')
            dirid=int(playlist(owned,True)['dirid'])
            detail=await raw(c.song.get_detail(track_id))
            track=detail.get('track_info') or {}
            if int(track.get('id',0))!=track_id or not isinstance(track.get('type'),int):
                raise QqError('无法读取歌曲类型，请重试')
            method=c.songlist.add_songs if action=='add' else c.songlist.del_songs
            ok=await method(dirid,[(track_id,track['type'])],tid=tid)
            if not ok: raise QqError('歌单修改未成功，请刷新后重试')
            return {'result':None}
        if op=='playlist_tracks':
            offset=int(a.get('offset',0))
            d=await raw(c.songlist.get_detail(int(a['id']),dirid=int(a.get('dirid') or 0),num=100,page=offset//100+1))
            items=d.get('songlist',[])
            return {'result':{'songs':[song(s) for s in items], 'total':int(d.get('total_song_num',len(items))), 'nextOffset':offset+len(items)}}
        if op=='song_lyric':
            d=await c.lyric.get_lyric(int(a['id']))
            return {'result':d.lyric}
        if op=='song_url': return await playback(c,a)
        if op=='download_info':
            if not saved: raise QqError('请先登录 QQ 音乐再下载')
            d=await raw(c.song.get_detail(int(a['id'])))
            track=d.get('track_info') or {}
            if int(track.get('id',0))!=int(a['id']): raise QqError('无法读取歌曲信息')
            return {'result': await download_info(c, track)}
        if op == 'download_match':
            if not saved:
                raise QqError('请先登录 QQ 音乐再使用补源下载')
            wanted = a.get('song') or {}
            if not wanted.get('artists') or not wanted.get('name'):
                raise QqError('无法读取原歌曲匹配信息')
            data = await search_tracks(c, f"{wanted['name']} {wanted['artists'][0]}")
            rows = data.get('body', {}).get('song', {}).get('list', [])
            matches = {int(track['id']): track for track in rows if track.get('id') and same_recording(track, wanted)}
            if len(matches) != 1:
                raise QqError('QQ 音乐未找到唯一同版本音源（歌名、歌手、专辑、时长须一致）')
            track_id = next(iter(matches))
            detail = await raw(c.song.get_detail(track_id))
            track = detail.get('track_info') or {}
            # Search summaries are not enough: recheck authoritative track details.
            if int(track.get('id', 0)) != track_id or not same_recording(track, wanted):
                raise QqError('QQ 音乐未找到与原歌曲一致的完整版本')
            return {'result': await download_info(c, track)}
        raise QqError('不支持的操作')

if __name__=='__main__':
    try:
        request=json.load(sys.stdin)
        print(json.dumps(asyncio.run(asyncio.wait_for(main(request),45)),ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'error': public_error(e)}, ensure_ascii=False))
        sys.exit(1)
