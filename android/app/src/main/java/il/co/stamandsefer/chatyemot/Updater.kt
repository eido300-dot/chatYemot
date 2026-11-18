package il.co.stamandsefer.chatyemot

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/** בודק GitHub Releases לגרסה חדשה (תג vX.Y.Z), מוריד את ה-APK ומפעיל התקנה. */
object Updater {

    private class Release(val versionCode: Int, val name: String, val notes: String, val apkUrl: String, val apiAsset: Boolean)

    fun checkOnLaunch(activity: Activity) {
        thread(isDaemon = true) {
            val rel = runCatching { latest() }.getOrNull() ?: return@thread
            if (rel.versionCode <= BuildConfig.VERSION_CODE) return@thread
            activity.runOnUiThread {
                if (activity.isFinishing) return@runOnUiThread
                AlertDialog.Builder(activity)
                    .setTitle("עדכון זמין: ${rel.name}")
                    .setMessage(rel.notes.take(600).ifBlank { "יש גרסה חדשה של האפליקציה." })
                    .setPositiveButton("עדכן עכשיו") { _, _ -> download(activity, rel) }
                    .setNegativeButton("אחר כך", null)
                    .show()
            }
        }
    }

    private fun open(url: String, accept: String?): HttpURLConnection {
        var current = url
        var sendAuth = BuildConfig.GITHUB_TOKEN.isNotEmpty() && current.startsWith("https://api.github.com/")
        repeat(5) {
            val c = URL(current).openConnection() as HttpURLConnection
            c.instanceFollowRedirects = false
            c.connectTimeout = 15000
            c.readTimeout = 30000
            if (accept != null) c.setRequestProperty("Accept", accept)
            if (sendAuth) c.setRequestProperty("Authorization", "Bearer ${BuildConfig.GITHUB_TOKEN}")
            c.setRequestProperty("User-Agent", "ChatYemotApp")
            if (c.responseCode in 300..399) {
                current = c.getHeaderField("Location")
                sendAuth = false // לא מעבירים טוקן לאחסון חיצוני (S3)
                c.disconnect()
            } else return c
        }
        throw IllegalStateException("too many redirects")
    }

    private fun latest(): Release? {
        val c = open("https://api.github.com/repos/${BuildConfig.GITHUB_REPO}/releases/latest", "application/vnd.github+json")
        if (c.responseCode != 200) return null
        val json = JSONObject(c.inputStream.bufferedReader().readText())
        val tag = json.getString("tag_name").removePrefix("v")
        val p = tag.split(".").map { it.toIntOrNull() ?: 0 } + listOf(0, 0, 0)
        val code = p[0] * 10000 + p[1] * 100 + p[2]
        val assets = json.getJSONArray("assets")
        for (i in 0 until assets.length()) {
            val a = assets.getJSONObject(i)
            if (a.getString("name").endsWith(".apk")) {
                val priv = BuildConfig.GITHUB_TOKEN.isNotEmpty()
                return Release(code, tag, json.optString("body"), if (priv) a.getString("url") else a.getString("browser_download_url"), priv)
            }
        }
        return null
    }

    private fun download(activity: Activity, rel: Release) {
        val progress = AlertDialog.Builder(activity).setTitle("מוריד עדכון…").setMessage("0%").setCancelable(false).show()
        thread(isDaemon = true) {
            try {
                val dir = File(activity.cacheDir, "updates").apply { mkdirs(); listFiles()?.forEach { it.delete() } }
                val out = File(dir, "update.apk")
                val c = open(rel.apkUrl, if (rel.apiAsset) "application/octet-stream" else null)
                if (c.responseCode != 200) throw IllegalStateException("HTTP ${c.responseCode}")
                val total = c.contentLengthLong
                c.inputStream.use { input ->
                    out.outputStream().use { o ->
                        val buf = ByteArray(64 * 1024); var done = 0L; var last = -1
                        while (true) {
                            val n = input.read(buf); if (n < 0) break
                            o.write(buf, 0, n); done += n
                            val pct = if (total > 0) (done * 100 / total).toInt() else -1
                            if (pct != last) { last = pct; activity.runOnUiThread { progress.setMessage(if (pct >= 0) "$pct%" else "${done / 1024} KB") } }
                        }
                    }
                }
                activity.runOnUiThread { progress.dismiss(); install(activity, out) }
            } catch (e: Exception) {
                activity.runOnUiThread {
                    progress.dismiss()
                    AlertDialog.Builder(activity).setTitle("העדכון נכשל").setMessage(e.message ?: "שגיאה").setPositiveButton("סגור", null).show()
                }
            }
        }
    }

    private fun install(activity: Activity, apk: File) {
        if (!activity.packageManager.canRequestPackageInstalls()) {
            AlertDialog.Builder(activity)
                .setTitle("נדרשת הרשאה")
                .setMessage("אשרו לאפליקציה להתקין עדכונים, ואז חזרו ופתחו אותה שוב.")
                .setPositiveButton("להגדרות") { _, _ ->
                    activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
                }.show()
            return
        }
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", apk)
        activity.startActivity(
            Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }
}
