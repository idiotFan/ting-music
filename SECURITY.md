# Security and privacy

Ting connects directly to NetEase Cloud Music and QQ Music. It does not operate a separate account server or collect analytics. Login and music permissions remain controlled by the respective provider.

## Account credentials

- On macOS and iOS, the Rust backend stores platform sessions in the system Keychain. The existing service identifier is `com.ting.music.demo`; changing it would change the storage namespace for existing users.
- Account passwords are not requested or stored. NetEase also accepts a phone number and SMS code. These are sent only to NetEase, retained in the active login form and a bounded backend pending session, and never stored in localStorage or log output. QR authorization is confirmed in the platform app.
- QQ and download networking run directly in Rust. Authentication results stay in the backend and are not returned to the web interface. No Python helper or runtime is bundled. Downloads use only Ting's current account sessions; they do not read another player's account files or ambient `.netrc` credentials.
- Playback requires a short-lived audio URL in the web view. Do not publish audio URLs, network captures, live QR codes, or account cookies when reporting a problem.
- Pending login requests carry a cancellation revision; closing or switching the flow invalidates late responses before credentials are committed. SMS requests have a server-side 60-second cooldown and a 10-minute session limit.
- On iOS, QR sharing writes a verified PNG to an app-cache subdirectory. The file is removed after sharing/canceling or on an error; exports older than 10 minutes are cleaned on the next share. A copy explicitly saved or shared by the user is controlled by the selected system activity.
- Logout removes the corresponding saved session. Credentials already held by a request that started before logout may remain in that request until it finishes or times out.

Local favorites, queue metadata, internal playlists, recent-playlist history and preferences are stored on the device. Recent-playlist data includes a provider account identifier so histories remain separated between accounts. These records do not contain account session secrets, but can reveal listening habits. Downloaded music and sidecars are ordinary files in the user's downloads directory; treat those files as personal data.

## Public repository and releases

The source archive is built from a reviewed Git commit rather than by recursively packaging the project directory. Build output, vendor bundles, local runtimes, test output, personal QA artifacts and credential files are excluded. The public QR fixture contains an `example.com` test URL, not a platform authentication challenge.

Run the release checks on the exact files being submitted, and run secret scanning again after the release commit. `scripts/scan-secrets.py` scans a Git-candidate snapshot and supports a separate history scan; `scripts/release.py` requires a clean checkout and passes both checks before producing an archive. A clean scan is evidence about that snapshot, not a guarantee about future changes. Do not suppress a finding until its origin and whether it can authenticate have been established. Revoke exposed credentials immediately; removing a file in a later commit does not remove it from repository history.

## Reporting a vulnerability

Use the repository's private vulnerability-reporting channel if it is enabled. Otherwise contact the maintainer privately before opening a public issue. Include the affected version, reproducible steps using dummy data, the expected security boundary, and a redacted impact description. Never attach active credentials or personal account exports to a public issue.

Only the current release branch is actively maintained. Platform integrations depend on unofficial interfaces and can change independently of Ting. macOS is the currently validated platform; other operating systems need separate credential-storage and packaging validation before release.

## iCloud Drive 文件夹同步

仅在用户通过系统选择器授权的目录内读写 Ting-Sync-v1，书签留在本机，云文件只含白名单歌单元数据与随机同步标识，不含音乐平台登录凭据。JSON 不使用自定义加密；权限沿用用户的 iCloud 账号与所选目录。停用不删除数据；系统授权和文件协调失效时保留本机修改。原生层拒绝符号链接及超限文件，Rust 拒绝未知字段与未知版本。
