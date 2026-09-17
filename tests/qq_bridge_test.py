"""Offline regression tests; dummy credentials only, no account/network writes."""
import asyncio, sys, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'resources/qq'))
import bridge
from qqmusic_api.core.versioning import DEFAULT_VERSION_POLICY, Platform
from qqmusic_api.models.request import Credential

class AuthTests(unittest.TestCase):
    def test_authenticated_web_and_desktop_cgi_carry_membership_session(self):
        cr=Credential(musicid=123,musickey='W_X_dummy',login_type=1)
        for platform in (Platform.WEB,Platform.DESKTOP):
            params=DEFAULT_VERSION_POLICY.build_comm(platform=platform,credential=cr,device=SimpleNamespace(),qimei=None,guid='test')
            self.assertEqual(params['authst'],'W_X_dummy')
            self.assertEqual(params['tmeLoginType'],1)
            self.assertEqual(params['uin'],123)
    def test_guest_has_no_fake_authentication(self):
        params=DEFAULT_VERSION_POLICY.build_comm(platform=Platform.WEB,credential=Credential(),device=SimpleNamespace(),qimei=None,guid='test')
        self.assertNotIn('authst',params)
        self.assertNotIn('tmeLoginType',params)

class ErrorTests(unittest.TestCase):
    def test_upstream_value_errors_with_app_like_prefix_do_not_expose_credentials(self):
        for prefix in ('无法读取', 'QQ 音乐未', '请先'):
            result = bridge.public_error(ValueError(prefix + ' authst=private MUSIC_U=private'))
            self.assertNotIn('private', result)
            self.assertNotIn('authst', result)
        self.assertEqual(bridge.public_error(bridge.QqError('请先登录 QQ 音乐')), '请先登录 QQ 音乐')

class Request:
    def __init__(self,data):self.data=data;self.param={}
    def __await__(self):
        async def done():return self.data
        return done().__await__()
class FakeClient:
    rows=[]
    def __init__(self,credential,**kw):self.credential=credential;self.song=self
    async def __aenter__(self):return self
    async def __aexit__(self,*args):pass
    def get_detail(self,value):return Request({'track_info':{'id':1,'mid':'songmid','type':7,'file':{'media_mid':'media'},'vs':[]}})
    def get_song_urls(self,files):
        FakeClient.files=files;FakeClient.req=Request({'midurlinfo':FakeClient.rows});return FakeClient.req
class PlaybackTests(unittest.TestCase):
    def run_request(self,level='lossless'):
        with patch.object(bridge,'Client',FakeClient):
            return asyncio.run(bridge.main({'operation':'song_url','args':{'id':1,'level':level},'credential':{'musicid':123,'musickey':'W_X_dummy','login_type':1},'devicePath':'unused'}))['result']
    def test_best_quality_wins_when_response_is_reversed(self):
        FakeClient.rows=[{'filename':'M500media.mp3','result':0,'purl':'M500media.mp3?vkey=dummy'},{'filename':'F000media.flac','result':0,'purl':'F000media.flac?vkey=dummy'}]
        result=self.run_request()
        self.assertEqual(result['level'],'lossless')
        self.assertEqual(result['format'],'flac')
        self.assertEqual(FakeClient.req.param['uin'],'123')
        self.assertTrue(all(f.song_type==7 for f in FakeClient.files))
    def test_denied_quality_is_not_reported_as_lossless(self):
        FakeClient.rows=[{'filename':'F000media.flac','result':104003,'purl':''},{'filename':'M800media.mp3','result':0,'purl':'M800media.mp3?vkey=dummy'}]
        self.assertEqual(self.run_request()['level'],'exhigh')
    def test_rejects_untrusted_audio_host(self):
        FakeClient.rows=[{'filename':'F000media.flac','result':0,'purl':'https://example.org/F000media.flac'}]
        with self.assertRaisesRegex(ValueError,'音源地址'):self.run_request()
class EditClient(FakeClient):
    allowed=True
    def __init__(self,**kw):super().__init__(**kw);self.user=self;self.songlist=self
    def get_created_songlist(self,uid):return Request({'v_playlist':[{'tid':88,'dirId':4,'title':'owned'}]})
    async def add_songs(self,dirid,tracks,tid=0):
        EditClient.called=(dirid,tracks,tid);return self.allowed
    async def del_songs(self,dirid,tracks,tid=0):return await self.add_songs(dirid,tracks,tid)
class EditTests(unittest.TestCase):
    def request(self,id=88,action='add'):
        with patch.object(bridge,'Client',EditClient):
            return asyncio.run(bridge.main({'operation':'playlist_edit','args':{'id':id,'dirid':9999,'trackId':1,'action':action},'credential':{'musicid':123,'musickey':'W_X_dummy','login_type':1},'devicePath':'unused'}))
    def setUp(self):EditClient.called=None;EditClient.allowed=True
    def test_rejects_non_owned_playlist_before_write(self):
        with self.assertRaisesRegex(ValueError,'只能修改'):self.request(89)
        self.assertIsNone(EditClient.called)
    def test_uses_server_directory_and_song_type_for_add_and_remove(self):
        for action in ('add','remove'):
            self.request(action=action)
            self.assertEqual(EditClient.called,(4,[(1,7)],88))
    def test_false_provider_result_is_not_success(self):
        EditClient.allowed=False
        with self.assertRaisesRegex(ValueError,'歌单修改未成功'):self.request()
class MatchingClient(FakeClient):
    candidates = []
    detail = {}
    searched_credential = None
    requested_audio = False

    def __init__(self, credential, **kw):
        super().__init__(credential, **kw)
        self.search = self

    def search_by_type(self, query, **kwargs):
        MatchingClient.searched_credential = self.credential
        return Request({'body': {'song': {'list': self.candidates}}})

    def get_detail(self, value):
        return Request({'track_info': self.detail})

    def get_song_urls(self, files):
        MatchingClient.requested_audio = True
        return super().get_song_urls(files)


class FallbackTests(unittest.TestCase):
    def setUp(self):
        self.wanted = {'id': 100, 'name': 'Example', 'artists': ['Artist'], 'album': 'Album', 'duration': 200000}
        self.track = {'id': 987, 'mid': 'songmid', 'name': 'Example', 'title': 'Example',
                      'singer': [{'name': 'Artist'}], 'album': {'name': 'Album'}, 'interval': 200,
                      'file': {'media_mid': 'media'}, 'type': 0}
        MatchingClient.candidates = [self.track]
        MatchingClient.detail = self.track
        MatchingClient.requested_audio = False
        MatchingClient.searched_credential = None
        FakeClient.rows = [{'filename': 'F000media.flac', 'result': 0, 'purl': 'F000media.flac?vkey=dummy'}]

    def request(self, credential=True):
        with patch.object(bridge, 'Client', MatchingClient):
            return asyncio.run(bridge.main({'operation': 'download_match', 'args': {'song': self.wanted},
                'credential': {'musicid': 123, 'musickey': 'W_X_dummy', 'login_type': 1} if credential else None,
                'devicePath': 'unused'}))

    def test_uses_current_qq_credential_and_returns_matched_qq_id(self):
        result = self.request()['result']
        self.assertEqual(MatchingClient.searched_credential.musickey, 'W_X_dummy')
        self.assertEqual(result['song']['id'], 987)
        self.assertEqual(result['playback']['level'], 'lossless')
        self.assertEqual(FakeClient.req.param['uin'], '123')

    def test_logged_out_never_uses_old_or_implicit_account(self):
        with self.assertRaisesRegex(ValueError, '请先登录'):
            self.request(credential=False)
        self.assertFalse(MatchingClient.requested_audio)
        self.assertIsNone(MatchingClient.searched_credential)

    def test_exact_artist_album_title_version_and_duration_are_required(self):
        wrong = [dict(self.track, title='Example (Live)'),
                 dict(self.track, singer=[{'name': 'Artist Junior'}]),
                 dict(self.track, singer=[{'name': 'Artist'}, {'name': 'Guest'}]),
                 dict(self.track, album={'name': 'Concert Album'}),
                 dict(self.track, album={}), dict(self.track, interval=196),
                 dict(self.track, subtitle='Live'), dict(self.track, subtitle='伴奏版本')]
        for candidate in wrong:
            with self.subTest(candidate=candidate):
                self.assertFalse(bridge.same_recording(candidate, self.wanted))
        self.assertTrue(bridge.same_recording(self.track, self.wanted))

    def test_ambiguous_recordings_are_not_automatically_selected(self):
        MatchingClient.candidates = [self.track, dict(self.track, id=988)]
        with self.assertRaisesRegex(ValueError, '唯一同版本'):
            self.request()
        self.assertFalse(MatchingClient.requested_audio)

    def test_search_match_must_be_revalidated_against_song_detail(self):
        MatchingClient.detail = dict(self.track, subtitle='现场')
        with self.assertRaisesRegex(ValueError, '完整版本'):
            self.request()
        self.assertFalse(MatchingClient.requested_audio)

if __name__=='__main__':unittest.main()
