package il.co.stamandsefer.chatyemot

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.RemoteInput
import org.json.JSONObject

object Notifier {
    const val CH_MSG = "messages"
    const val ACT_PLAY = "il.co.stamandsefer.chatyemot.PLAY"
    const val ACT_REPLY = "il.co.stamandsefer.chatyemot.REPLY"
    const val EXTRA_ID = "id"
    const val KEY_REPLY = "reply_text"
    @Volatile var appVisible = false

    fun notifId(id: Long) = id.toInt() + 100

    fun ensureChannel(ctx: Context) {
        ctx.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CH_MSG, "הודעות", NotificationManager.IMPORTANCE_HIGH).apply {
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            })
    }

    /** מציג התראה על הודעות חדשות של אחרים (נקרא מ-FCM). */
    fun fetchAndShow(ctx: Context) {
        if (!Api.init()) { showGeneric(ctx); return }
        val prefs = ctx.getSharedPreferences("svc", Context.MODE_PRIVATE)
        var last = prefs.getLong("last", -1)
        val a = Api.messages()
        if (last < 0) last = if (a.length() > 0) a.getJSONObject(0).getLong("id") else 0
        val fresh = (a.length() - 1 downTo 0).map { a.getJSONObject(it) }.filter { it.getLong("id") > last }
        for (m in fresh) {
            last = maxOf(last, m.getLong("id"))
            if (m.getLong("user_id") != Api.myId && !appVisible) show(ctx, m)
        }
        prefs.edit().putLong("last", last).apply()
    }

    /** גיבוי: אם השליפה נכשלה (רשת, session שפג) עדיין מציגים התראה, כדי שאנדרואיד לא יוריד עדיפות. */
    fun showGeneric(ctx: Context) {
        if (appVisible) return
        ensureChannel(ctx)
        val open = PendingIntent.getActivity(
            ctx, 0, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        ctx.getSystemService(NotificationManager::class.java).notify(
            1, NotificationCompat.Builder(ctx, CH_MSG)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("צ'אטייב")
                .setContentText("הודעה חדשה. פתחו את האפליקציה.")
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(open).setAutoCancel(true).build()
        )
    }

    fun show(ctx: Context, m: JSONObject) {
        ensureChannel(ctx)
        val id = m.getLong("id")
        val audio = m.getString("kind") == "audio"
        val transcript = m.optString("transcript").takeIf { it.isNotBlank() && it != "null" }
        val text = if (audio) transcript ?: "🎤 הודעה קולית" else m.optString("body")

        val open = PendingIntent.getActivity(
            ctx, 0, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val replyIntent = PendingIntent.getForegroundService(
            ctx, id.toInt(), Intent(ctx, ActionService::class.java).setAction(ACT_REPLY).putExtra(EXTRA_ID, id),
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val b = NotificationCompat.Builder(ctx, CH_MSG)
            .setSmallIcon(R.drawable.ic_stat)
            .setColor(0xFF00765F.toInt())
            .setLargeIcon(android.graphics.BitmapFactory.decodeResource(ctx.resources, R.mipmap.ic_launcher))
            .setContentTitle(m.optString("name"))
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(open)
            .setAutoCancel(true)
            .addAction(
                NotificationCompat.Action.Builder(android.R.drawable.ic_menu_send, "השב", replyIntent)
                    .addRemoteInput(RemoteInput.Builder(KEY_REPLY).setLabel("תגובה…").build())
                    .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
                    .setAllowGeneratedReplies(false).build()
            )
        if (audio) {
            val play = PendingIntent.getForegroundService(
                ctx, id.toInt() + 1_000_000_000,
                Intent(ctx, ActionService::class.java).setAction(ACT_PLAY).putExtra(EXTRA_ID, id),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
            b.addAction(android.R.drawable.ic_media_play, "השמע", play)
        }
        ctx.getSystemService(NotificationManager::class.java).notify(notifId(id), b.build())
        wakeScreen(ctx)
    }

    @Suppress("DEPRECATION")
    private fun wakeScreen(ctx: Context) {
        (ctx.getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP, "chatyemot:screen")
            .acquire(8000)
    }
}
