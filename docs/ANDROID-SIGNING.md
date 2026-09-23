# Android 正式签名

CI 每次都会构建 Debug 签名的 APK。仓库配置了下面四个 secret 后，Android 任务会额外构建一个用 Ting 自己的密钥签名的 release APK（产物名 `Ting-…-Android-Release`）；没有配置时这一步自动跳过，不影响其他构建。

| Secret | 内容 |
| --- | --- |
| `TING_ANDROID_KEYSTORE_BASE64` | keystore 文件的 base64 |
| `TING_ANDROID_KEYSTORE_PASSWORD` | keystore 口令 |
| `TING_ANDROID_KEY_ALIAS` | 密钥别名 |
| `TING_ANDROID_KEY_PASSWORD` | 密钥口令 |

生成与上传（在自己的电脑上执行，口令不要写进仓库或聊天）：

```bash
keytool -genkeypair -v -keystore ~/.android/ting-release.jks -alias ting -keyalg RSA -keysize 4096 -validity 36500
```

```bash
base64 -i ~/.android/ting-release.jks | gh secret set TING_ANDROID_KEYSTORE_BASE64 --repo idiotFan/ting-music
```

```bash
gh secret set TING_ANDROID_KEYSTORE_PASSWORD --repo idiotFan/ting-music
```

```bash
gh secret set TING_ANDROID_KEY_ALIAS --repo idiotFan/ting-music --body ting
```

```bash
gh secret set TING_ANDROID_KEY_PASSWORD --repo idiotFan/ting-music
```

keystore 一旦用于发布就不能更换：Android 只允许同一签名的新版本覆盖安装。请把 `~/.android/ting-release.jks` 与口令一起离线备份。

实现：`scripts/prepare-android.mjs` 在 `tauri android init` 生成的 `build.gradle.kts` 里加入 `signingConfigs.ting`，仅在环境变量 `TING_ANDROID_KEYSTORE` 指向存在的文件时启用；CI 把 secret 解码到 runner 临时目录，构建后立即删除。
