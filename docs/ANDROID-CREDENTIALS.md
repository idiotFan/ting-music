# Android 登录持久化

Android 版的网易云和 QQ 登录凭据保存在应用私有目录 `noBackupFilesDir/credentials-v1`，使用 Android Keystore 内不可导出的 AES-256 密钥进行 GCM 认证加密。两个平台各有独立记录，账号名作为附加认证数据，防止记录互换。每次写入生成新 IV，通过 AtomicFile 原子替换旧记录。

密钥不需要每次使用都弹出指纹确认，应用重启后可恢复会话。凭据不写入 WebView/localStorage、不参与 iCloud 同步，也不进入 Android 系统备份或设备迁移。卸载、清除应用数据或上游登录过期后需要重新登录。旧 Android 包只把登录保留在内存中，更新到此实现后需要重新登录一次。

原生 Kotlin 实现在 `src-tauri/android/main`。`scripts/prepare-android.mjs` 在 Android init 后、dev/build 前同步到可重新生成的工程中，同时配置 R8 保留规则。Rust 在插件初始化后恢复两个账号，后端通过 `PluginHandle` 调用存储；所有来自前端的 `plugin:credentials|*` 请求均被拒绝，不能直接读取、修改或删除凭据。

Keystore 和文件操作放在独立工作线程。保存失败会返回登录警告，同时保留内存会话；读取失败不删除原记录；主动退出必须成功清除持久记录才完成退出。两个平台的退出互不影响。

参考：[Android Keystore](https://developer.android.com/privacy-and-security/keystore)、[Tauri 原生移动插件](https://v2.tauri.app/develop/plugins/develop-mobile/)。

## 真机回归

先构建 Android debug APK，再构建对应的 instrumentation APK。测试只操作单独的 `credential-test-*` 目录和密钥，使用固定虚拟字符串，不读取或退出真实账号。

```sh
npm run tauri -- android build --debug --target aarch64 --apk --ci -- --locked
src-tauri/gen/android/gradlew --project-dir src-tauri/gen/android \
  :app:assembleUniversalDebugAndroidTest -x :app:rustBuildUniversalDebug

# DEVICE 为 adb devices 列出的目标设备，首次安装按手机提示允许。
adb -s "$DEVICE" install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb -s "$DEVICE" install -r src-tauri/gen/android/app/build/outputs/apk/androidTest/universal/debug/app-universal-debug-androidTest.apk
node scripts/test-android-credentials.mjs "$DEVICE"
```

脚本检查：加密往返、重复保存更换 IV、平台分别退出、密文篡改、跨平台记录替换、无效写入保留旧记录、密钥丢失时不覆盖原记录，以及在两个不同进程中分别写入和恢复两套凭据。跨进程用例核对 PID，不能用同一对象内的读回代替。

2026-09-19：荣耀 MTN-AN00 / Android 16 上上述 7 项 instrumentation 执行通过。修复包覆盖安装成功，冷启动 578 ms；WebView 实测 `read/write/remove` 三种直接存储调用全部被阻止。49 项 Rust 回归、21 项 Node 测试及 4 种移动设备登录文案回归通过（7 项联网 Rust 测试未运行）。真实账号登录后的重启恢复需另外验证，不能由虚拟凭据测试代替。
