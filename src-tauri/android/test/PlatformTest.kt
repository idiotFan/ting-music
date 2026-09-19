package com.ting.music.demo

import android.app.Notification
import android.graphics.Bitmap
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSession
import android.media.session.PlaybackState
import androidx.core.content.FileProvider
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class PlatformTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext

    @Test fun qrSharingPreservesEveryByteAndPrivateFilesStayPrivate() {
        val bytes = instrumentation.context.assets.open("share-qr.png").use { it.readBytes() }
        val value = "data:image/png;base64," + android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
        val file = PlatformPlugin.writeQr(context, value)
        try {
            assertArrayEquals(bytes, file.readBytes())
            val uri = FileProvider.getUriForFile(context, context.packageName + ".fileprovider", file)
            assertArrayEquals(bytes, context.contentResolver.openInputStream(uri)!!.use { it.readBytes() })
            assertThrows(IllegalArgumentException::class.java) {
                FileProvider.getUriForFile(context, context.packageName + ".fileprovider", File(context.noBackupFilesDir, "credentials-v1/qq-session.enc"))
            }
            assertThrows(Exception::class.java) { PlatformPlugin.writeQr(context, "data:image/png;base64,bm90LXB uZw==") }
        } finally { file.delete() }
    }

    @Test fun nativeMetadataNavigationAndArtworkFollowTheTrack() {
        val next = CountDownLatch(1)
        val previous = CountDownLatch(1)
        lateinit var controller: MediaController
        fun snapshot(title: String) = JSONObject("""{"track":{"trackId":"$title","title":"$title","artist":"Fixture","album":"Fixture"},"playbackState":"paused","position":{"duration":120,"position":8,"playbackRate":1},"volume":0.7}""")
        instrumentation.runOnMainSync {
            TingMedia.initialize(context) {
                if (it.optString("action") == "nexttrack") next.countDown()
                if (it.optString("action") == "previoustrack") previous.countDown()
            }
            TingMedia.update(snapshot("one"), "fixture-cover", Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888))
            @Suppress("DEPRECATION")
            val token = TingMedia.notification()!!.extras.getParcelable<MediaSession.Token>(Notification.EXTRA_MEDIA_SESSION)!!
            controller = MediaController(context, token)
            assertEquals("one", controller.metadata!!.getString(MediaMetadata.METADATA_KEY_TITLE))
            assertNotNull(controller.metadata!!.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART))
            val actions = controller.playbackState!!.actions
            assertTrue(actions and PlaybackState.ACTION_SKIP_TO_NEXT != 0L)
            assertTrue(actions and PlaybackState.ACTION_SKIP_TO_PREVIOUS != 0L)
            assertEquals(8000L, controller.playbackState!!.position)
            TingMedia.update(snapshot("two"), "fixture-cover", null)
            assertEquals("two", controller.metadata!!.getString(MediaMetadata.METADATA_KEY_TITLE))
            assertNotNull(controller.metadata!!.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART))
            controller.transportControls.skipToNext()
            controller.transportControls.skipToPrevious()
        }
        try {
            assertTrue(next.await(5, TimeUnit.SECONDS))
            assertTrue(previous.await(5, TimeUnit.SECONDS))
        } finally {
            instrumentation.runOnMainSync {
                TingMedia.update(JSONObject("""{"track":null,"playbackState":"none"}"""), "", null)
                assertNull(TingMedia.notification())
            }
        }
    }
}
