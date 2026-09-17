# Security and privacy

Ting connects directly to NetEase Cloud Music and QQ Music. It does not operate a separate account server or collect analytics. Login and music permissions remain controlled by the respective provider.

## Account credentials

- On macOS and iOS, the Rust backend stores platform sessions in the system Keychain. The existing service identifier is `com.ting.music.demo`; changing it would change the storage namespace for existing users.
- Account passwords are not requested or stored. Scan a login QR code and confirm authorization in the platform's mobile application.
- QQ and download networking run directly in Rust. Authentication results stay in the backend and are not returned to the web interface. No Python helper or runtime is bundled. Downloads use only Ting's current account sessions; they do not read another player's account files or ambient `.netrc` credentials.
- Playback requires a short-lived audio URL in the web view. Do not publish audio URLs, network captures, live QR codes, or account cookies when reporting a problem.
- Logout removes the corresponding saved session. Credentials already held by a request that started before logout may remain in that request until it finishes or times out.

Local favorites, queue metadata, internal playlists, recent-playlist history and preferences are stored on the device. Recent-playlist data includes a provider account identifier so histories remain separated between accounts. These records do not contain account session secrets, but can reveal listening habits. Downloaded music and sidecars are ordinary files in the user's downloads directory; treat those files as personal data.

## Public repository and releases

The source archive is built from a reviewed Git commit rather than by recursively packaging the project directory. Build output, vendor bundles, local runtimes, test output, personal QA artifacts and credential files are excluded. The public QR fixture contains an `example.com` test URL, not a platform authentication challenge.

Run the release checks on the exact files being submitted, and run secret scanning again after the release commit. `scripts/scan-secrets.py` scans a Git-candidate snapshot and supports a separate history scan; `scripts/release.py` requires a clean checkout and passes both checks before producing an archive. A clean scan is evidence about that snapshot, not a guarantee about future changes. Do not suppress a finding until its origin and whether it can authenticate have been established. Revoke exposed credentials immediately; removing a file in a later commit does not remove it from repository history.

## Reporting a vulnerability

Use the repository's private vulnerability-reporting channel if it is enabled. Otherwise contact the maintainer privately before opening a public issue. Include the affected version, reproducible steps using dummy data, the expected security boundary, and a redacted impact description. Never attach active credentials or personal account exports to a public issue.

Only the current release branch is actively maintained. Platform integrations depend on unofficial interfaces and can change independently of Ting. macOS is the currently validated platform; other operating systems need separate credential-storage and packaging validation before release.
