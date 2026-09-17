# Publication security audit

Date: 2026-09-17. Scope: files eligible for Git in the `ting-music` repository, plus manual inspection of IPC credential handling and public image assets. This was a targeted release audit, not a penetration test or a review of the user's Keychain, browser session or home-directory credentials.

## Evidence

1. The repository had no commits at the start of the audit, so there was no existing committed secret history to preserve or rewrite.
2. Gitleaks **8.30.1**, downloaded from its official GitHub release with its published SHA-256 checksum verified, scanned a snapshot exported using `git ls-files --cached --others --exclude-standard`. The initial snapshot contained 101 files and approximately 605 KB of scan-eligible content. Result: **0 leaks**. Scan reports and tools remain under ignored `work/security-tools/` and are not release assets.
3. An additional content scan checked private-key headers, provider token formats, credential assignments, signed audio URLs, personal absolute paths and email addresses. The only credential-pattern match was the explicitly nonfunctional `W_X_dummy` test value in `tests/qq_bridge_test.py`. No account credential, signed audio URL, private key, personal home-directory path or personal email was found in that snapshot.
4. The previous platform QR JPEG was replaced in the public fixture set with a deterministic synthetic JPEG containing `https://example.com/ting/test/wechat-qr?fixture=synthetic-470`. The generated image is exactly 470 × 470 pixels and was actually decoded to verify the complete payload. Both Playwright screenshot regressions passed: 400 × 560 and 480 × 720 windows, complete payload equality, final rendered pixels identical to the adapted PNG.
5. README screenshots were visually inspected. They show mock music data and a logged-out interface, with no account identifier, login QR code or credential.
6. Runtime review confirmed that macOS sessions are persisted in Keychain; Python receives credentials through stdin; QQ authentication response fields are consumed in Rust; the UI does not receive account session objects. The allowed Tauri window operations are restricted to the main window, and production content has an explicit CSP without remote scripts or shell execution permissions.

The completed initial publication snapshot contained 122 Git files and approximately 712 KB of scan-eligible content. Gitleaks scanned both that snapshot and the first committed history (commit `32b87fb`): **0 leaks**. Later release commits must pass the same source and full-history gate again; the initial result is not a claim about future changes.

## Application-resource scan

A separate scan of the prepared runtime resources produced 36 initial findings: 32 SHA-256 build-manifest values and four matches in three dependency files. These were reviewed individually rather than silently suppressing all vendor files:

| Fixed upstream package/file | Finding | Verification |
| --- | --- | --- |
| `cryptography` 50.0.1, `hazmat/bindings/_rust/openssl/hpke.pyi` | Two Python parameter annotations named `private_key`, typed as `x25519.X25519PrivateKey`; no actual key value | File SHA-256 `a7f8462e7e981fe11aac91755796d4b14b638a9be2100a5c4793b4b141c92ed7` |
| `qh3` 2.0.3, `quic/configuration.py` | A PEM header delimiter string used by a parser; no key body | File SHA-256 `24543569eb120e7696c27ef174ab3434b65245304616c339653365c75dc9edab` |
| `qqmusic-api-python` 0.7.3, `qqmusic_api/utils/qimei.py` | A fixed protocol SDK constant distributed publicly by the upstream library; not an account session | File SHA-256 `09331eddb65ea5b5d862260727cefc40d2779d5d337ee6bc26f4b424f8c9e407` |

For each file, the auditor fetched the fixed package's official PyPI wheel independently, checked its SHA-256 against the dependency lock, then compared the installed file byte for byte with that wheel. Build-manifest hashes identify source and resource content; they cannot authenticate to a music account.

Any application-only scan exceptions must be constrained to these verified files and matching code, with file hashes checked first. Source and Git-history scans continue using default rules without these exceptions. A later package version or modified vendor file requires a new review, not a broader blanket exclusion.

## Privacy corrections

- The public QR regression fixture now uses synthetic data while retaining the oversized JPEG rendering case. Optional real QR QA files remain outside the Git candidate set.
- Source packaging must use the Git candidate manifest. Copying the entire local project directory would include ignored historical QA and user-specific artifacts.
- The download helper now uses only explicitly supplied Ting account sessions and no legacy account files. Artwork and audio requests use separate empty-cookie sessions with ambient credential discovery disabled, an HTTPS CDN allowlist, checked redirects and byte limits. Application-owned error types separate public messages from raw provider exceptions; QQ likewise uses a dedicated public error type. Child-output limits, deadlines, process termination and Rust-owned scratch cleanup bound failed operations.
- Third-party license files must remain in application dependency bundles. A successful secrets scan does not establish license compliance; dependency licenses and local patches are described in `THIRD_PARTY_NOTICES.md`.

## Boundaries

This audit does not claim platform authorization for every song, safe operation on unvalidated operating systems, Apple notarization, or the absence of future vulnerabilities. Account display names and recent-playlist account identifiers are local private data even though they are not authentication secrets. Public bug reports should use synthetic data and omit raw network logs.

## Dependency advisory review

`npm audit --json` checked production and development dependencies and returned no advisories (117 dependency entries reported by npm).

The initial `pip-audit` run checked 28 unique pinned Python distributions and found one advisory in Requests 2.32.5, reported twice by the upstream feed: [CVE-2026-25645 / GHSA-gc5v-m9x4-r6x2](https://github.com/psf/requests/security/advisories/GHSA-gc5v-m9x4-r6x2). The affected helper is `extract_zipped_paths`, which Ting does not call directly. Requests was nevertheless upgraded to the patched **2.33.0** and its dependency lock updated. A repeat scan with **pip-audit 2.10.1** returned **no known vulnerabilities** in the two pinned requirement sets.

The official [OSV API](https://osv.dev/) checked all 472 registry packages in `Cargo.lock`. The following advisory groups require distinguishing the lockfile from the actual target dependency tree:

| Dependency | Advisory | macOS Apple Silicon release |
| --- | --- | --- |
| `glib` 0.18.5 | [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html): unsound iterator implementation, fixed upstream in 0.20.0 | Not present in `cargo tree --target aarch64-apple-darwin`; part of the unvalidated GTK/Linux branch. Must be addressed before shipping that platform. |
| `proc-macro-error` 1.0.4 | [RUSTSEC-2024-0370](https://rustsec.org/advisories/RUSTSEC-2024-0370.html): unmaintained | Not present in the macOS target tree. |
| `unic-char-property`, `unic-char-range`, `unic-common`, `unic-ucd-ident`, `unic-ucd-version` 0.9.0 | RustSec maintenance notices [0081](https://rustsec.org/advisories/RUSTSEC-2025-0081.html), [0075](https://rustsec.org/advisories/RUSTSEC-2025-0075.html), [0080](https://rustsec.org/advisories/RUSTSEC-2025-0080.html), [0100](https://rustsec.org/advisories/RUSTSEC-2025-0100.html), [0098](https://rustsec.org/advisories/RUSTSEC-2025-0098.html) | Transitive dependencies through Tauri → `tauri-utils` → `urlpattern`. These are maintenance notices, with no patched versions specified, rather than confirmed exploit findings in Ting. Track the upstream replacement. |

No ignore rule was added to suppress these advisories. These findings prevent a claim that the entire cross-platform lockfile has no security or maintenance notices.
