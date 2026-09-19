package com.ting.music.demo

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.Intent
import android.graphics.BitmapFactory
import android.os.Environment
import android.util.Base64
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.util.UUID
import java.lang.ref.WeakReference
import java.util.concurrent.Executors

@TauriPlugin
class PlatformPlugin(private val host: Activity) : Plugin(host) {
    private val worker = Executors.newSingleThreadExecutor()

    @Command fun initMedia(invoke: Invoke) {
        host.runOnUiThread {
            try {
                val plugin = WeakReference(this)
                TingMedia.initialize(host.applicationContext) { event -> plugin.get()?.trigger("media-action", event) }
                invoke.resolve()
            } catch (_: Exception) { invoke.reject("系统媒体初始化失败") }
        }
    }

    @Command fun updateMedia(invoke: Invoke) {
        // Decode artwork away from the main thread; keep the existing image until ready.
        worker.execute {
            try {
                val args = invoke.getArgs()
                val snapshot = args.getJSONObject("snapshot")
                val track = snapshot.optJSONObject("track")
                val image = if (args.optBoolean("artworkChanged", true)) track?.optString("artwork") ?: "" else TingMedia.artworkSource
                val bitmap = if (image.isNotEmpty() && image != TingMedia.artworkSource) {
                    require(image.startsWith("data:image/png;base64,") && image.length <= 2_000_000)
                    val bytes = Base64.decode(image.substringAfter(','), Base64.DEFAULT)
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                    require(bounds.outWidth in 1..512 && bounds.outHeight in 1..512)
                    requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size))
                } else null
                host.runOnUiThread {
                    try { TingMedia.update(snapshot, image, bitmap); invoke.resolve() }
                    catch (_: Exception) { invoke.reject("系统媒体更新失败") }
                }
            } catch (_: Exception) { invoke.reject("系统媒体数据无效") }
        }
    }

    @Command fun shareQr(invoke: Invoke) {
        worker.execute {
            try {
                val file = writeQr(host, invoke.getArgs().getString("dataUrl"))
                host.runOnUiThread {
                    try { share(file, "image/png"); invoke.resolve() }
                    catch (_: Exception) { invoke.reject("无法打开系统分享") }
                }
            } catch (_: Exception) { invoke.reject("无法准备二维码图片") }
        }
    }

    private fun share(file: File, mime: String) {
        val uri = FileProvider.getUriForFile(host, "${host.packageName}.fileprovider", file)
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = mime
            putExtra(Intent.EXTRA_STREAM, uri)
            clipData = ClipData.newRawUri("Ting file", uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        host.startActivity(Intent.createChooser(intent, "保存或分享"))
    }

    @Command fun openDownloads(invoke: Invoke) {
        worker.execute {
            try {
                val directory = File(requireNotNull(host.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)), "Ting")
                val files = directory.listFiles()?.filter {
                    it.isFile && it.extension.lowercase() in setOf("mp3", "flac", "m4a", "wav", "ogg", "aac")
                }?.sortedByDescending { it.lastModified() } ?: emptyList()
                host.runOnUiThread {
                    try {
                        val builder = AlertDialog.Builder(host).setTitle("Ting 下载 · 点击保存或分享")
                        if (files.isEmpty()) builder.setMessage("还没有下载的歌曲")
                        else builder.setItems(files.map { it.name }.toTypedArray()) { _, index ->
                            try { share(files[index], "audio/${files[index].extension.lowercase()}") }
                            catch (_: Exception) { android.widget.Toast.makeText(host, "无法分享文件，请重试", android.widget.Toast.LENGTH_SHORT).show() }
                        }
                        builder.setNegativeButton("关闭", null).show()
                        invoke.resolve()
                    } catch (_: Exception) { invoke.reject("无法打开下载文件列表") }
                }
            } catch (_: Exception) { invoke.reject("下载目录暂不可用") }
        }
    }

    companion object {
        internal fun writeQr(context: android.content.Context, dataUrl: String): File {
            require(dataUrl.startsWith("data:image/png;base64,") && dataUrl.length <= 1_500_000)
            val bytes = Base64.decode(dataUrl.substringAfter(','), Base64.DEFAULT)
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            require(bounds.outWidth in 64..2048 && bounds.outHeight in 64..2048)
            val folder = File(context.cacheDir, "login-qr").apply { check(isDirectory || mkdirs()) }
            folder.listFiles()?.filter { it.name.startsWith("Ting-login-") && System.currentTimeMillis() - it.lastModified() > 600_000 }?.forEach { it.delete() }
            return File(folder, "Ting-login-${UUID.randomUUID()}.png").apply { writeBytes(bytes) }
        }
    }
}
