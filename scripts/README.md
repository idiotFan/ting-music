# 构建和发布脚本

桌面交付目标为 **macOS 15+、Apple Silicon**，iOS 16+ 为真机测试目标。QQ 接口、音频下载、校验与标签写入均在 Rust 内完成；应用不携带 Python、FFmpeg 或额外后台服务。

## 构建

需要 Node.js 22、Rust stable 和 Xcode。Python 3 只用于开发机上的发布、安全扫描和基础设施测试。

```sh
npm ci
node scripts/prepare-desktop.mjs
npm run tauri -- build -- --locked
```

`prepare-desktop.mjs` 根据 Cargo.lock 下载 Rust 依赖。`tauri.mjs` 从任意工作目录解析项目路径，并在构建前调用 `preflight.mjs`，检查版本及 Git 候选文件，生成源码指纹与资源清单。若存在 `work/toolchain/`，包装脚本使用该目录中的隔离 Rust 工具链；否则使用系统工具链。

iOS 的初始化、开发者签名及 Xcode 27 兼容说明见 [Rust 迁移与 iOS](../docs/RUST-MIGRATION.md)。生成的 Xcode 工程、签名身份、描述文件和构建产物不进入 Git。

## 回归与凭据扫描

```sh
npm run format:check
npm run build
npm test
npx playwright test
node scripts/cargo.mjs fmt --manifest-path src-tauri/Cargo.toml -- --check
node scripts/cargo.mjs test --locked --manifest-path src-tauri/Cargo.toml
python3 -B scripts/infrastructure-test.py
python3 -B scripts/scan-secrets.py --gitleaks /path/to/gitleaks --history
npm audit --audit-level=high
```

Playwright 需要安装 Chromium。Rust 音频测试使用开发机 FFmpeg 生成合成 MP3/FLAC，应用运行不依赖它。离线测试使用本地模拟服务，不需要账号。标记 `ignored` 的在线测试需显式执行；会员回归读取本机 Ting 的钥匙串会话，不打印凭据或播放地址，不修改线上歌单。

凭据扫描仅复制 Git 候选文件到临时快照，避免把被忽略的私有文件带入扫描包；`--history` 另扫完整 Git 历史。Gitleaks 使用 `--redact`。源码与历史扫描不设置凭据白名单；应用扫描仅允许构建清单中格式严格匹配的 SHA256 元数据误报，其他命中均阻断发布。

CI 执行前端、浏览器、Rust 和发布基础设施检查，构建 macOS 应用并检查 npm 漏洞；另有完整历史凭据扫描。工作流只有仓库读取权限，不自动发布。

## 生成交付包

先完成审查与回归并提交代码，然后从干净提交构建：

```sh
npm run tauri -- build -- --locked
python3 -B scripts/release.py --gitleaks /path/to/gitleaks
```

输出结构：

```text
Release/v0.9.0/
├── macOS-AppleSilicon/
│   ├── 听 · Ting.app
│   └── Ting-v0.9.0-macOS-AppleSilicon.zip
├── Source/
│   └── Ting-v0.9.0-source.zip
├── SHA256SUMS.txt
└── release.json
```

应用面向 **macOS 15+、Apple Silicon（arm64）**。脚本验证版本、bundle identifier、当前提交、源码指纹与每个资源的 SHA256，拒绝残留 Python 运行时；扫描暂存应用，逐层 ad-hoc 签名并验证。源码来自该提交的 `git archive`。校验文件记录相对路径和提交。

脚本不会自动安装、替换正在运行的应用或上传 GitHub。已有版本目录拒绝覆盖；`--output <dir>` 可选择另一个输出根目录，`--source-only` 仅生成源码与校验元数据。`Release/` 被 Git 忽略。

iOS 开发签名应用另放 `Release/v<version>/iOS-arm64/`；它只适用于描述文件中的设备，并受签名有效期限制。包含设备与团队标识的开发描述文件不作为公开 GitHub release 资产上传。

macOS 当前使用 ad-hoc 签名，尚未 Developer ID 公证。面向大众分发仍需开发者证书签名与 notarize，私钥或证书不能进入仓库。
