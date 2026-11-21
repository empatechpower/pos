package com.rezein.hub

import android.annotation.SuppressLint
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * The Hub plus POS edition's first screen: the shop's POS web app, full screen. The same app also runs the hub (print jobs, sign-in texts)
 * and puts the customer's items and total on the till's second screen. Scans from the till's scanner are passed to the POS.
 */
class PosActivity : Activity() {
    private lateinit var config: Config
    private lateinit var web: WebView
    private var display: DisplayHost? = null

    private val scanReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val extra = DisplayBridge.SCAN_ACTIONS[intent.action] ?: return
            val code = intent.getStringExtra(extra)?.trim().orEmpty()
            if (code.isNotEmpty()) runOnUiThread { web.evaluateJavascript(DisplayBridge.scanScript(code), null) }
        }
    }

    /** What the POS web app can call. Only this app's own pages are ever loaded, so only the shop can reach it. */
    private inner class Native {
        @JavascriptInterface fun display(json: String) { display?.push(json) }
        @JavascriptInterface fun hasSecondScreen(): Boolean = display?.hasSecondScreen ?: false
        @JavascriptInterface fun openHubSettings() { runOnUiThread { startActivity(Intent(this@PosActivity, MainActivity::class.java)) } }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        config = Config(this)
        // Not linked yet: the hub's own screen links this tablet to the shop (shop address and a one-time code), then the POS opens.
        if (!config.isLinked) { startActivity(Intent(this, MainActivity::class.java)); finish(); return }
        if (config.wantRunning && !HubState.running) HubService.start(this)

        val base = config.baseUrl!!.trimEnd('/')
        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.mediaPlaybackRequiresUserGesture = false
        web.addJavascriptInterface(Native(), "RezeinNative")
        val host = Uri.parse(base).host
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // Stay on the shop's own pages; anything else (a payment page, a link) opens in the browser.
                if (request.url.host == host) return false
                startActivity(Intent(Intent.ACTION_VIEW, request.url))
                return true
            }
        }
        setContentView(web)
        immersive()
        web.loadUrl("$base/pos")

        display = DisplayHost(this, "$base/display").also { it.start() }
        val filter = IntentFilter().also { f -> DisplayBridge.SCAN_ACTIONS.keys.forEach { f.addAction(it) } }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(scanReceiver, filter, Context.RECEIVER_EXPORTED) else registerReceiver(scanReceiver, filter)
    }

    private fun immersive() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) immersive()
    }

    @Deprecated("Back goes back inside the POS; it never closes the till by accident.")
    override fun onBackPressed() {
        if (::web.isInitialized && web.canGoBack()) web.goBack()
    }

    override fun onDestroy() {
        if (::web.isInitialized) {
            try { unregisterReceiver(scanReceiver) } catch (_: Exception) { /* not registered */ }
            display?.stop()
            web.destroy()
        }
        super.onDestroy()
    }
}
