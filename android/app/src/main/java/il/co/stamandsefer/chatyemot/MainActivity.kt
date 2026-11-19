package il.co.stamandsefer.chatyemot

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingWebPermission: PermissionRequest? = null
    private val serverHost: String = Uri.parse(BuildConfig.SERVER_URL).host ?: ""

    private val filePicker =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
            val data = res.data
            val uris: Array<Uri>? = when {
                res.resultCode != RESULT_OK || data == null -> null
                data.clipData != null -> Array(data.clipData!!.itemCount) { data.clipData!!.getItemAt(it).uri }
                data.data != null -> arrayOf(data.data!!)
                else -> null
            }
            fileCallback?.onReceiveValue(uris)
            fileCallback = null
        }

    private val micPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            val req = pendingWebPermission
            pendingWebPermission = null
            if (granted) req?.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else req?.deny()
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this)
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            userAgentString = "$userAgentString ChatYemotApp/${BuildConfig.VERSION_NAME}"
        }
        CookieManager.getInstance().setAcceptCookie(true)

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (uri.host == serverHost) return false
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
                return true
            }

            // האתר הוא SPA: הכניסה אינה טוענת דף חדש, לכן מזהים בקשת login ורושמים אחריה
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): android.webkit.WebResourceResponse? {
                if (request.method == "POST") {
                    val p = request.url.path ?: ""
                    if (p.endsWith("/api/login"))
                        webView.postDelayed({ if (Api.loggedIn()) registerForPush(force = true) }, 3000)
                    else if (p.endsWith("/api/logout"))
                        getSharedPreferences("svc", MODE_PRIVATE).edit().putBoolean("reg", false).apply()
                }
                return null
            }

            override fun onPageFinished(view: WebView, url: String?) {
                // אחרי כניסה לאתר קיימת עוגיית session: מפעילים את שירות ההתראות
                if (Api.loggedIn()) registerForPush()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showOffline(view)
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    val wantsMic = PermissionRequest.RESOURCE_AUDIO_CAPTURE in request.resources
                    if (!wantsMic) { request.deny(); return@runOnUiThread }
                    if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO)
                        == PackageManager.PERMISSION_GRANTED
                    ) {
                        request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                    } else {
                        pendingWebPermission = request
                        micPermission.launch(Manifest.permission.RECORD_AUDIO)
                    }
                }
            }

            override fun onShowFileChooser(
                view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    filePicker.launch(params.createIntent())
                    true
                } catch (e: Exception) {
                    fileCallback = null
                    false
                }
            }
        }

        webView.setDownloadListener { url, _, _, _, _ ->
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
            }
        })

        if (savedInstanceState == null) webView.loadUrl(BuildConfig.SERVER_URL)
        else webView.restoreState(savedInstanceState)

        Updater.checkOnLaunch(this)
        askNotificationPermission()
    }

    private val startPermissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { }

    private fun registerForPush(force: Boolean = false) {
        fun say(m: String) = runOnUiThread { android.widget.Toast.makeText(this, m, android.widget.Toast.LENGTH_LONG).show() }
        if (!force && getSharedPreferences("svc", MODE_PRIVATE).getBoolean("reg", false)) return
        runCatching {
            com.google.firebase.messaging.FirebaseMessaging.getInstance().token
                .addOnSuccessListener { t ->
                    Thread {
                        val err = Api.registerFcmToken(applicationContext, t)
                        if (err != null) say("רישום התראות נכשל: $err")
                        else getSharedPreferences("svc", MODE_PRIVATE).edit().putBoolean("reg", true).apply()
                    }.start()
                }
                .addOnFailureListener { e -> say("טוקן התראות לא התקבל: ${e.message}") }
        }.onFailure { say("Firebase לא מאותחל: ${it.message}") }
    }

    private fun askNotificationPermission() {
        val need = buildList {
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
            add(Manifest.permission.RECORD_AUDIO)
        }.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (need.isNotEmpty()) startPermissions.launch(need.toTypedArray())
    }

    private fun showOffline(view: WebView) {
        val html = """
            <html dir="rtl" lang="he"><body style="font-family:sans-serif;text-align:center;padding:15vh 24px;background:#efeae2">
            <h2>אין חיבור לשרת</h2><p>בדקו את החיבור לאינטרנט ונסו שוב.</p>
            <button style="font-size:20px;padding:12px 32px" onclick="location.href='${BuildConfig.SERVER_URL}'">נסו שוב</button>
            </body></html>""".trimIndent()
        view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        Notifier.appVisible = true
        webView.onResume()
        if (Api.loggedIn()) registerForPush()
    }

    override fun onPause() {
        CookieManager.getInstance().flush()
        Notifier.appVisible = false
        webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
