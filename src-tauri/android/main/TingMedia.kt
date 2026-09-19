package com.ting.music.demo

import android.app.*
import android.annotation.SuppressLint
import android.content.*
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.*
import app.tauri.plugin.JSObject
import org.json.JSONObject

/** One Android session routes transport commands to Ting's existing queue. */
@SuppressLint("StaticFieldLeak") // Process-scoped Application only; callbacks hold no Activity.
internal object TingMedia {
    private lateinit var context: Application
    private var session: MediaSession? = null
    private var send: ((JSObject) -> Unit)? = null
    private var cover: Bitmap? = null
    private var track: JSONObject? = null
    private var metadataKey = ""
    private var starting = false
    @Volatile var artworkSource = ""
        private set
    var playing = false
        private set
    const val CHANNEL = "ting-playback"
    const val NOTIFICATION = 1905

    fun initialize(app: Context, callback: (JSObject) -> Unit) {
        context = app.applicationContext as Application
        send = callback
        if (session != null) return
        if (Build.VERSION.SDK_INT >= 26) {
            manager().createNotificationChannel(NotificationChannel(CHANNEL, "音乐播放", NotificationManager.IMPORTANCE_LOW))
        }
        session = MediaSession(context, "Ting").apply {
            setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS or MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS)
            setSessionActivity(PendingIntent.getActivity(context, 0,
                Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() = action("play")
                override fun onPause() = action("pause")
                override fun onSkipToNext() = action("nexttrack")
                override fun onSkipToPrevious() = action("previoustrack")
                override fun onStop() = action("stop")
                override fun onSeekTo(pos: Long) = action("seekto", pos / 1000.0)
            }, Handler(Looper.getMainLooper()))
        }
        val filter = IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) { if (playing) action("pause") }
        }
        if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        else context.registerReceiver(receiver, filter)
    }

    fun action(name: String, seek: Double? = null) {
        if (track == null) return
        val event = JSObject().apply { put("action", name); if (seek != null) put("seekTime", seek) }
        send?.invoke(event)
    }

    fun update(snapshot: JSONObject, image: String, bitmap: Bitmap?) {
        val media = checkNotNull(session)
        track = snapshot.optJSONObject("track")
        playing = track != null && snapshot.optString("playbackState") == "playing"
        if (image != artworkSource) {
            artworkSource = image
            cover = bitmap
        }
        val position = snapshot.optJSONObject("position")
        val duration = ((position?.optDouble("duration", 0.0) ?: 0.0) * 1000).toLong()
        val current = ((position?.optDouble("position", 0.0) ?: 0.0) * 1000).toLong()
        val key = listOf(track?.optString("trackId"), track?.optString("title"), track?.optString("artist"), track?.optString("album"), duration, artworkSource.hashCode()).joinToString("|")
        if (key != metadataKey) {
            metadataKey = key
            media.setMetadata(track?.let { song ->
                MediaMetadata.Builder()
                    .putString(MediaMetadata.METADATA_KEY_MEDIA_ID, song.optString("trackId"))
                    .putString(MediaMetadata.METADATA_KEY_TITLE, song.optString("title"))
                    .putString(MediaMetadata.METADATA_KEY_ARTIST, song.optString("artist"))
                    .putString(MediaMetadata.METADATA_KEY_ALBUM, song.optString("album"))
                    .putLong(MediaMetadata.METADATA_KEY_DURATION, duration)
                    .putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, cover)
                    .putBitmap(MediaMetadata.METADATA_KEY_ART, cover).build()
            })
        }
        media.isActive = track != null
        media.setPlaybackState(PlaybackState.Builder()
            .setActions(if (track == null) 0 else ACTIONS)
            .setState(if (track == null) PlaybackState.STATE_NONE else if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                current.coerceAtLeast(0), if (playing) (position?.optDouble("playbackRate", 1.0) ?: 1.0).toFloat() else 0f,
                SystemClock.elapsedRealtime())
            .build())
        val service = TingPlaybackService.instance
        if (track == null) {
            service?.stopSelf()
            manager().cancel(NOTIFICATION)
        } else if (service != null) service.refresh()
        else if (playing && !starting) {
            starting = true
            try {
                val intent = Intent(context, TingPlaybackService::class.java)
                if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
            } catch (error: Exception) { starting = false; throw error }
        }
    }

    fun serviceStarted() { starting = false }
    fun manager() = context.getSystemService(NotificationManager::class.java)
    fun notification(): Notification? {
        val song = track ?: return null
        val media = session ?: return null
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, CHANNEL) else Notification.Builder(context)
        builder.setSmallIcon(R.drawable.ic_stat_ting)
            .setContentTitle(song.optString("title"))
            .setContentText(song.optString("artist"))
            .setLargeIcon(cover)
            .setContentIntent(media.controller.sessionActivity)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setOngoing(playing)
        fun button(action: String, label: String, icon: Int) {
            val pending = PendingIntent.getBroadcast(context, action.hashCode(),
                Intent(context, TingMediaReceiver::class.java).setAction(action), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            builder.addAction(Notification.Action.Builder(icon, label, pending).build())
        }
        button("previoustrack", "上一首", android.R.drawable.ic_media_previous)
        button(if (playing) "pause" else "play", if (playing) "暂停" else "播放",
            if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play)
        button("nexttrack", "下一首", android.R.drawable.ic_media_next)
        return builder.setStyle(Notification.MediaStyle().setMediaSession(media.sessionToken).setShowActionsInCompactView(0, 1, 2)).build()
    }

    const val ACTIONS = PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
        PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SEEK_TO or PlaybackState.ACTION_STOP
}

class TingMediaReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        intent.action?.takeIf { it in setOf("play", "pause", "nexttrack", "previoustrack") }?.let { TingMedia.action(it) }
    }
}

class TingPlaybackService : Service() {
    private var foreground = false
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() { super.onCreate(); instance = this; TingMedia.serviceStarted() }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // A fresh process cannot restore a WebView player: never restart a ghost service.
        val notification = TingMedia.notification()
        if (notification == null) { stopSelf(); return START_NOT_STICKY }
        if (Build.VERSION.SDK_INT >= 29) startForeground(TingMedia.NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        else startForeground(TingMedia.NOTIFICATION, notification)
        foreground = true
        refresh()
        return START_NOT_STICKY
    }
    @SuppressLint("NotificationPermission") // MediaStyle with an active MediaSession is exempt on Android 13+.
    fun refresh() {
        val notification = TingMedia.notification() ?: run { stopSelf(); return }
        if (TingMedia.playing) {
            if (Build.VERSION.SDK_INT >= 29) startForeground(TingMedia.NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
            else startForeground(TingMedia.NOTIFICATION, notification)
            foreground = true
        } else {
            if (foreground) stopForeground(STOP_FOREGROUND_DETACH)
            foreground = false
            TingMedia.manager().notify(TingMedia.NOTIFICATION, notification)
        }
    }
    override fun onTaskRemoved(rootIntent: Intent?) { TingMedia.action("stop"); stopSelf() }
    override fun onDestroy() {
        instance = null
        if (foreground) stopForeground(STOP_FOREGROUND_REMOVE)
        getSystemService(NotificationManager::class.java).cancel(TingMedia.NOTIFICATION)
        super.onDestroy()
    }
    companion object { var instance: TingPlaybackService? = null }
}
