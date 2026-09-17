# Public test fixtures

`wechat-login-470.jpg` is a synthetic 470 × 470 JPEG. It contains exactly:

```text
https://example.com/ting/test/wechat-qr?fixture=synthetic-470
```

It is not a platform login challenge and cannot sign in to an account. The image uses a version 5 QR code, error correction M, 10 pixels per module and a five-module white margin. Its dimensions and JPEG encoding exercise the oversized WeChat QR rendering path without publishing an actual authentication challenge.

Recreate from the repository root using the installed `qrcode` package and FFmpeg:

```sh
mkdir -p work
node --input-type=module - <<'JS'
import QRCode from 'qrcode';
await QRCode.toFile('work/synthetic-wechat-470.png',
  'https://example.com/ting/test/wechat-qr?fixture=synthetic-470',
  {version: 5, errorCorrectionLevel: 'M', margin: 5, scale: 10,
   color: {dark: '#000000', light: '#ffffff'}});
JS
ffmpeg -hide_banner -loglevel error -y \
  -i work/synthetic-wechat-470.png -q:v 2 tests/fixtures/wechat-login-470.jpg
npx playwright test tests/qq.spec.ts --grep '470px WeChat QR'
```

The tests decode the source JPEG and actual rendered screenshots, compare their complete payloads, and compare screenshot pixels to the final PNG. They cover 400 × 560 and 480 × 720 windows. Real QR images used for optional local verification belong only in the ignored `work/` directory; never add them to Git or release archives.
