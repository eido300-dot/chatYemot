package il.co.stamandsefer.chatyemot

import android.content.Context
import android.webkit.CookieManager
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** קריאות לשרת בעזרת עוגיית ה-session שה-WebView שמר בכניסה לאתר. */
object Api {
    private val base = BuildConfig.SERVER_URL.trimEnd('/')
    @Volatile private var csrf = ""
    @Volatile var myId = -1L

    fun loggedIn() = cookie() != null
    private fun cookie(): String? {
        val cm = CookieManager.getInstance()
        for (u in listOf(BuildConfig.SERVER_URL, base, base + "/api/me", base.substringBefore("/", "") + "//" + java.net.URI(base).host + "/")) {
            val c = cm.getCookie(u)
            if (c != null && c.contains("session=")) return c
        }
        return null
    }

    /** לאבחון: שמות העוגיות שה-WebView מחזיק לכתובת השרת. */
    fun cookieNames(): String =
        CookieManager.getInstance().getCookie(BuildConfig.SERVER_URL)
            ?.split(";")?.joinToString(",") { it.substringBefore("=").trim() } ?: "אין"

    fun open(method: String, path: String, body: String? = null): HttpURLConnection {
        val c = URL(base + path).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 15000
        c.readTimeout = 20000
        c.setRequestProperty("Cookie", cookie() ?: "")
        if (method != "GET") c.setRequestProperty("x-csrf-token", csrf)
        if (body != null) {
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            c.outputStream.use { it.write(body.toByteArray()) }
        }
        return c
    }

    /** מביא csrf ומזהה משתמש; false אם לא מחובר. */
    fun init(): Boolean {
        if (!loggedIn()) return false
        val c = open("GET", "/api/me")
        if (c.responseCode != 200) { c.disconnect(); return false }
        val j = JSONObject(c.inputStream.bufferedReader().readText())
        csrf = j.getString("csrf")
        myId = j.getJSONObject("user").getLong("id")
        return true
    }

    fun messages(): JSONArray {
        val c = open("GET", "/api/messages")
        if (c.responseCode != 200) { c.disconnect(); return JSONArray() }
        return JSONArray(c.inputStream.bufferedReader().readText())
    }

    fun post(path: String, json: String, expect: Int = 200): Boolean {
        val c = open("POST", path, json)
        return (c.responseCode == expect).also { c.disconnect() }
    }

    /** רושם את טוקן FCM אצל השרת. מחזיר null בהצלחה, אחרת תיאור התקלה. */
    fun registerFcmToken(ctx: Context, token: String): String? {
        return try {
            if (!init()) return "לא מחובר (init)"
            if (!post("/api/fcm", JSONObject().put("token", token).toString())) return "השרת דחה את /api/fcm"
            val prefs = ctx.getSharedPreferences("svc", Context.MODE_PRIVATE)
            if (prefs.getLong("last", -1) < 0) {
                val a = messages()
                prefs.edit().putLong("last", if (a.length() > 0) a.getJSONObject(0).getLong("id") else 0).apply()
            }
            null
        } catch (e: Exception) { e.toString() }
    }
}
