package il.co.stamandsefer.chatyemot

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.RemoteInput
import org.json.JSONObject
import java.io.File
import kotlin.concurrent.thread

/** שירות קצר-חיים לפעולות מההתראה: השמעת הקלטה ותגובה. נעצר מיד בסיום. */
class ActionService : Service() {
    private var player: MediaPlayer? = null

    override fun onBind(i: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("action", "פעולות", NotificationManager.IMPORTANCE_MIN))
        startForeground(2, NotificationCompat.Builder(this, "action")
            .setSmallIcon(android.R.drawable.stat_notify_chat).setContentTitle("צ'אטייב").build())
        val id = intent?.getLongExtra(Notifier.EXTRA_ID, 0) ?: 0
        thread(isDaemon = true) {
            try {
                if (!Api.init()) return@thread
                when (intent?.action) {
                    Notifier.ACT_PLAY -> play(id)
                    Notifier.ACT_REPLY -> {
                        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(Notifier.KEY_REPLY)?.toString()
                        if (!text.isNullOrBlank()) reply(id, text.trim())
                    }
                }
            } catch (_: Exception) {
            } finally {
                if (player == null) stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    private fun markRead(id: Long) {
        runCatching { Api.post("/api/read", """{"id":$id}""") }
    }

    private fun play(id: Long) {
        val c = Api.open("GET", "/api/messages/$id/audio")
        if (c.responseCode != 200) return
        val f = File(cacheDir, "play.wav")
        c.inputStream.use { i -> f.outputStream().use { i.copyTo(it) } }
        player = MediaPlayer().apply {
            setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            setDataSource(f.path)
            setOnCompletionListener { release(); player = null; stopSelf() }
            prepare()
            start()
        }
        markRead(id)
    }

    private fun reply(id: Long, text: String) {
        val nm = getSystemService(NotificationManager::class.java)
        val ok = Api.post("/api/messages", JSONObject().put("body", text).put("parentId", id.toString()).toString(), 201)
        if (ok) { nm.cancel(Notifier.notifId(id)); markRead(id) }
        else nm.notify(Notifier.notifId(id), NotificationCompat.Builder(this, Notifier.CH_MSG)
            .setSmallIcon(android.R.drawable.stat_notify_error).setContentTitle("השליחה נכשלה")
            .setContentText("התגובה לא נשלחה: $text").setAutoCancel(true).build())
    }

    override fun onDestroy() {
        player?.release()
        super.onDestroy()
    }
}
