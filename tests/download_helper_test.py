"""Offline download regression tests. Fixtures are generated audio; no saved sessions."""
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'resources/downloader'))
import download_one as d
from mutagen import File


class Downloads(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workspace = tempfile.TemporaryDirectory()
        cls.root = Path(cls.workspace.name)
        executable = shutil.which('ffmpeg') or '/opt/homebrew/bin/ffmpeg'
        for name, args in [('fixture.mp3', ['-ar', '44100', '-b:a', '320k']),
                           ('fixture.flac', ['-ar', '192000', '-sample_fmt', 's32'])]:
            subprocess.run([executable, '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
                            'sine=frequency=440:duration=20', '-ac', '2', *args, str(cls.root / name)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.workspace.cleanup()

    def info(self, source='qq', sid=123, ext='flac'):
        return {'song': {'id': sid, 'source': source, 'name': 'Example', 'artist': 'Artist', 'album': 'Album',
                         'cover': '', 'duration': 20000}, 'artists': ['Artist'], 'year': '2026',
                'lyric': '[00:00.00]Test lyric', 'playback': {
                    'url': 'https://stream.qqmusic.qq.com/audio?signature=PRIVATE_EXAMPLE',
                    'trial': False, 'level': 'lossless' if ext == 'flac' else 'exhigh', 'format': ext}}

    def request(self, folder, source='qq', ext='flac'):
        return {'id': 123, 'source': source, 'out': str(folder), 'info': self.info(source, ext=ext)}

    def copy_audio(self, url, path, expected, expected_md5=None):
        shutil.copyfile(self.root / f'fixture{path.suffix}', path)

    def test_session_uses_only_explicit_cookie_and_never_reads_home(self):
        with patch.object(Path, 'home', side_effect=AssertionError('No legacy account files')):
            guest = d.ncm_with_cookie('')
            logged_in = d.ncm_with_cookie('MUSIC_U=fixture-session; __csrf=fixture-csrf')
        self.assertEqual(list(guest.s.cookies), [])
        self.assertEqual(logged_in.s.cookies.get('MUSIC_U'), 'fixture-session')
        self.assertFalse(logged_in.s.trust_env)
        self.assertFalse(hasattr(d.lib, 'QQ'))
        guest.close()
        logged_in.close()

    def test_prepare_forwards_only_ting_cookie_and_requests_qq_fallback_without_reading_files(self):
        song = {'id': 123, 'name': 'Example', 'ar': [{'name': 'Artist'}], 'al': {'name': 'Album'}, 'dt': 20000}
        ncm = SimpleNamespace(details=lambda ids: [song], lyric=lambda sid: ('', ''), close=lambda: None)
        with patch.object(d, 'ncm_with_cookie', return_value=ncm) as constructor, patch.object(d, 'highest', return_value=None):
            plan = d.prepare({'id': 123, 'cookie': ''})
        constructor.assert_called_once_with('')
        self.assertIsNone(plan['playback'])
        self.assertEqual(plan['song']['id'], 123)
        self.assertNotIn('cookie', plan)

    def test_highest_rejects_trials_and_reports_actual_tier(self):
        class NCM:
            def post(self, path, **args):
                return {'data': [{'url': 'https://m10.music.126.net/audio', 'level': 'lossless', 'br': 900000,
                                  'freeTrialInfo': {'start': 0} if args['level'] == 'jymaster' else None}]}
        self.assertEqual(d.highest(NCM(), 1)['level'], 'lossless')

    def test_network_error_is_not_silently_treated_as_missing_source(self):
        class NCM:
            def post(self, *args, **kwargs):
                raise d.requests.Timeout('private signed URL')
        with self.assertRaises(d.requests.Timeout):
            d.highest(NCM(), 1)

    def test_direct_qq_writes_correct_origin_audio_ids_and_192khz_tags(self):
        with tempfile.TemporaryDirectory() as folder:
            request = self.request(folder)
            with patch.object(d, 'ncm_with_cookie', side_effect=AssertionError('No NCM lookup')), \
                    patch.object(d.lib, 'fetch_cover', return_value=None), patch.object(d, 'fetch_audio', side_effect=self.copy_audio):
                result = d.run(request)
            self.assertEqual(result['source'], 'qq')
            self.assertEqual(result['sampleRate'], 192000)
            self.assertEqual(result['bitDepth'], 24)
            self.assertIn('[QQ-123]', result['filename'])
            tags = File(result['path']).tags
            self.assertEqual(tags['comment'], ['origin:qq:123 audio:qq:123 quality:lossless'])
            self.assertEqual(tags['ting_origin_platform'], ['qq'])
            self.assertEqual(tags['ting_audio_id'], ['123'])
            text = Path(result['path']).with_suffix('.json').read_text()
            self.assertNotIn('PRIVATE_EXAMPLE', text)
            self.assertNotIn('https:', text)
            self.assertEqual(json.loads(text)['origin'], {'platform': 'qq', 'id': 123})
            self.assertFalse(list(Path(folder).glob('.ting-*')))

    def test_cross_platform_fallback_preserves_both_id_namespaces_and_existing_files(self):
        with tempfile.TemporaryDirectory() as folder:
            request = self.request(folder, source='netease', ext='mp3')
            request['info']['playback'] = None
            request['fallback'] = self.info(sid=987, ext='mp3')
            with patch.object(d.lib, 'fetch_cover', return_value=None), patch.object(d, 'fetch_audio', side_effect=self.copy_audio):
                first = d.run(request)
                second = d.run(request)
            self.assertNotEqual(first['path'], second['path'])
            tags = File(first['path']).tags
            self.assertEqual(str(tags['TIT2']), 'Example')
            self.assertEqual(tags.getall('COMM')[0].text, ['origin:netease:123 audio:qq:987 quality:exhigh'])
            data = json.loads(Path(first['path']).with_suffix('.json').read_text())
            self.assertEqual(data['origin'], {'platform': 'netease', 'id': 123})
            self.assertEqual(data['audio'], {'platform': 'qq', 'id': 987})
            self.assertTrue(Path(first['path']).with_suffix('.lrc').exists())

    def test_trial_rejected_before_downloading(self):
        request = self.request('unused')
        request['info']['playback']['trial'] = True
        with patch.object(d, 'fetch_audio') as fetch, self.assertRaisesRegex(d.DownloadError, '完整可下载'):
            d.run(request)
        fetch.assert_not_called()

    def test_truncated_flac_is_rejected_even_when_header_duration_is_intact(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'audio.flac'
            data = (self.root / 'fixture.flac').read_bytes()
            path.write_bytes(data[:len(data) // 2])
            self.assertEqual(File(path).info.length, 20)
            with self.assertRaisesRegex(d.DownloadError, '音频'):
                d.validate_audio(path, 20000)

    def test_corrupt_flac_frames_and_truncated_mp3_do_not_pass_full_decode(self):
        with tempfile.TemporaryDirectory() as folder:
            flac = bytearray((self.root / 'fixture.flac').read_bytes())
            start = len(flac) // 2
            flac[start:start + 4096] = bytes(4096)
            path = Path(folder) / 'corrupt.flac'
            path.write_bytes(flac)
            with self.assertRaises(d.DownloadError):
                d.validate_audio(path, 20000)
            mp3 = (self.root / 'fixture.mp3').read_bytes()
            path = Path(folder) / 'truncated.mp3'
            path.write_bytes(mp3[:len(mp3) // 2])
            with self.assertRaises(d.DownloadError):
                d.validate_audio(path, 20000)

    def test_cdn_download_checks_exact_length_and_checksum_without_cookie_session(self):
        data = b'fixture audio bytes' * 1000
        class Response:
            headers = {'Content-Length': str(len(data))}
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def iter_content(self, size): yield data
        with tempfile.TemporaryDirectory() as folder, patch.object(d.lib, 'open_cdn', return_value=Response()) as request:
            d.fetch_audio('https://stream.qqmusic.qq.com/audio', Path(folder) / 'complete', len(data), hashlib.md5(data).hexdigest())
            session = request.call_args.args[0]
            self.assertFalse(list(session.cookies))
            self.assertFalse(session.trust_env)
            with self.assertRaisesRegex(d.DownloadError, '校验和'):
                d.fetch_audio('https://stream.qqmusic.qq.com/audio', Path(folder) / 'wrong-hash', len(data), '0' * 32)
            with self.assertRaisesRegex(d.DownloadError, '不完整'):
                d.fetch_audio('https://stream.qqmusic.qq.com/audio', Path(folder) / 'wrong-size', len(data) + 1)

    def test_wrong_version_duration_rejected(self):
        with self.assertRaisesRegex(d.DownloadError, '时长'):
            d.validate_audio(self.root / 'fixture.flac', 10000)

    def test_failed_validation_leaves_no_published_audio_or_scratch(self):
        with tempfile.TemporaryDirectory() as folder:
            def damaged(url, path, *args):
                path.write_bytes(b'not audio' * 200)
            with patch.object(d, 'fetch_audio', side_effect=damaged), self.assertRaises(Exception):
                d.run(self.request(folder))
            self.assertEqual(list(Path(folder).iterdir()), [])

    def test_untrusted_host_and_http_redirect_are_rejected_without_credentials(self):
        with d.requests.Session() as session:
            with patch.object(session, 'get') as get, self.assertRaises(d.DownloadError):
                d.lib.open_cdn(session, 'https://qq.com.evil.example/audio')
            get.assert_not_called()
            response = SimpleNamespace(is_redirect=True, headers={'Location': 'http://stream.qqmusic.qq.com/audio'}, close=lambda: None)
            with patch.object(session, 'get', return_value=response) as get, self.assertRaises(d.DownloadError):
                d.lib.open_cdn(session, 'https://stream.qqmusic.qq.com/audio')
            self.assertEqual(get.call_count, 1)

    def test_cover_rejects_external_hosts_and_excessive_bytes(self):
        with patch.object(d.lib, 'open_cdn', wraps=d.lib.open_cdn), patch.object(d.requests.Session, 'get') as get:
            self.assertIsNone(d.lib.fetch_cover('https://attacker.example/cover.jpg'))
            get.assert_not_called()
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def iter_content(self, count): yield b'x' * (8 * 1024 * 1024 + 1)
        with patch.object(d.lib, 'open_cdn', return_value=Response()) as request:
            self.assertIsNone(d.lib.fetch_cover('https://y.gtimg.cn/cover.jpg'))
            session = request.call_args.args[0]
            self.assertFalse(list(session.cookies))
            self.assertFalse(session.trust_env)

    def test_upstream_and_filesystem_errors_do_not_leak_secrets_or_paths(self):
        for exc in [ValueError('MUSIC_U=private authst=private'), OSError('/Users/private/session'),
                    d.requests.RequestException('https://cdn.example/?key=private')]:
            self.assertNotIn('private', d.public_error(exc))
        self.assertIn('网络', d.public_error(d.requests.Timeout('private')))
        self.assertEqual(d.public_error(d.DownloadError('下载超时，请重试')), '下载超时，请重试')


if __name__ == '__main__':
    unittest.main()
