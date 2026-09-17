# 构建和发布脚本

当前原生交付目标为 **macOS 15+、Apple Silicon**。源码不携带 Python 二进制或机器相关的 wheels；它们在构建前生成。运行打包后的应用不要求用户安装 Homebrew、Python 或 FFmpeg。

## 准备与校验

```sh
npm ci
node scripts/prepare-desktop.mjs
node scripts/preflight.mjs
npm run tauri -- build -- --locked
```

准备过程使用开发机器的 `python3`（macOS Xcode Command Line Tools 自带版本即可）下载固定版本的 Astral `python-build-standalone`。下载 URL、版本、字节数及 SHA256 均存于 `runtime-lock.json`，来自官方发布资产；先校验，再解包执行。已有相同版本不会重复下载。压缩包路径和符号链接会在解包前检查。

`prepare-resources.py` 使用打包的 CPython，按 requirements 的准确版本和 `dependencies-lock.json` 的 SHA256 下载官方 PyPI wheel，并应用 QQMusicApi 的 WEB / DESKTOP 认证补丁。安装发生在临时目录；导入检查成功后才替换旧依赖。构建前自动检查运行时、依赖版本清单、补丁和各处应用版本，缺失时直接失败。

运行时位于 `resources/python/`，依赖位于各自 `resources/*/vendor/`，均在 `.gitignore` 中。不要把这些生成目录加入 Git。

## 回归与凭据扫描

```sh
npm test
npx playwright test
node scripts/cargo.mjs test --locked --manifest-path src-tauri/Cargo.toml
resources/python/bin/python3.12 -I -B tests/qq_bridge_test.py
resources/python/bin/python3.12 -I -B tests/download_helper_test.py
resources/python/bin/python3.12 -I -B scripts/infrastructure-test.py
python3 -B scripts/scan-secrets.py --gitleaks /path/to/gitleaks --history
```

浏览器测试、Python 音频 fixture 生成需要开发依赖：Playwright Chromium 与 FFmpeg。最终应用用内置 miniaudio 解码，不调用 FFmpeg。

凭据扫描仅复制 Git 候选文件到临时快照，避免读入被忽略的本机私有数据；`--history` 另扫所有可达 Git 提交。Gitleaks 使用 `--redact`，不输出凭据原文。CI 在 macOS 上运行前端、浏览器、Rust、Python 回归并构建应用，另有完整历史扫描任务。工作流拥有只读仓库权限，不自动发布。

源码和 Git 历史扫描使用 Gitleaks 默认规则，不设白名单。应用包扫描额外核对已知公开依赖误报：两个 Python 类型标注、PEM 分隔符字面量、QQMusicApi 的公开 SDK 协议常量。只有文件 SHA256、规则及命中行均与独立校验过的 PyPI wheel 一致才会接受；构建清单中也只接受整行的 64 位 SHA256 元数据。其他命中一律阻断发布。

## 生成交付包

先完成回归与审查并提交代码，然后从干净提交构建，再执行打包：

```sh
npm run tauri -- build -- --locked
python3 -B scripts/release.py --gitleaks /path/to/gitleaks
```

输出到项目根目录 `Release/v<version>/`，按目标平台整理：

```text
Release/v0.8.0/
├── macOS-AppleSilicon/
│   ├── 听 · Ting.app
│   └── Ting-v0.8.0-macOS-AppleSilicon.zip
├── Source/
│   └── Ting-v0.8.0-source.zip
├── SHA256SUMS.txt
└── release.json
```

`macOS-AppleSilicon/` 中的应用面向 **macOS 15+、Apple Silicon（arm64）**，保留已签名并验证的 `.app`，可直接在本机打开。`SHA256SUMS.txt` 和 `release.json` 的归档路径均相对于版本目录；后者同时记录 Git commit、最低系统版本和架构。

脚本要求干净工作区；源码来自该提交的 `git archive`。构建时记录当前提交、源码内容指纹与每个内置资源的 SHA256；同版本旧构建也会被拒绝。应用先复制到暂存目录，核对版本、bundle identifier、构建来源与资源完整性，扫描整个暂存应用的凭据，使用隔离环境验证内置 Python 与 native wheels，再对嵌套原生文件及应用逐层作 ad-hoc 签名并验证。

脚本**不会安装、替换正在运行的应用、修改用户资料或上传 GitHub**。现有版本目录会拒绝覆盖。可用 `--output <dir>` 选择其他根目录，仍会建立 `v<version>/`；`--source-only` 保留相同布局，仅生成 `Source/` 和两份顶层校验元数据。`Release/` 和旧的 `releases/` 均被 Git 忽略。

当前签名为 ad-hoc，尚无 Developer ID 公证。面向大众发布需在具备开发者证书的受控流水线中签名与 notarize，不能把私钥或证书放进仓库。

## 更新 Python 依赖

1. 修改 `resources/qq/requirements.txt` 或 `resources/downloader/requirements.txt` 的固定版本。
2. 执行 `python3 scripts/update-dependency-lock.py`，核对差异。
3. 执行 `node scripts/prepare-desktop.mjs` 并完成全部测试与漏洞检查。

运行时升级需单独更新 `runtime-lock.json`：只使用 [Astral 官方 release](https://github.com/astral-sh/python-build-standalone/releases)，从发布资产记录取得正确 SHA256 和字节数，保留更新审查。不要改为不固定版本的下载地址。
