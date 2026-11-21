package com.rezein.hub

import android.annotation.SuppressLint
import android.app.Presentation
import android.content.Context
import android.hardware.display.DisplayManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Display
import android.view.WindowManager
import android.webkit.WebView
import android.webkit.WebViewClient

/** The customer's screen: a full-screen page (the shop's /display) on the till's second display. */
class DisplayPresentation(context: Context, display: Display, private val url: String) : Presentation(context, display) {
    private var web: WebView? = null
    private var ready = false
    private var last: String? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window?.setFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON, WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val w = WebView(context)
        w.settings.javaScriptEnabled = true
        w.settings.domStorageEnabled = true
        w.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, u: String?) {
                ready = true
                last?.let { push(it) } // a page that loads after the till already sent a sale shows it straight away
            }
        }
        setContentView(w)
        web = w
        w.loadUrl(url)
    }

    fun push(stateJson: String) {
        last = stateJson
        if (ready) web?.evaluateJavascript(DisplayBridge.pushScript(stateJson), null)
    }

    override fun onStop() {
        web?.destroy()
        web = null
        ready = false
        super.onStop()
    }
}

/** Finds the second display, shows the customer page on it, and keeps it shown as the display is plugged in or removed. */
class DisplayHost(private val context: Context, private val url: String) {
    private val manager = context.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
    private val ui = Handler(Looper.getMainLooper())
    private var presentation: DisplayPresentation? = null
    private var last: String? = null

    private val listener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(id: Int) = ui.post { sync() }.let { }
        override fun onDisplayRemoved(id: Int) = ui.post { sync() }.let { }
        override fun onDisplayChanged(id: Int) = Unit
    }

    fun start() {
        manager.registerDisplayListener(listener, ui)
        sync()
    }

    fun stop() {
        manager.unregisterDisplayListener(listener)
        presentation?.dismiss()
        presentation = null
    }

    /** Whether a second screen is attached right now. */
    val hasSecondScreen: Boolean get() = manager.getDisplays(DisplayManager.DISPLAY_CATEGORY_PRESENTATION).isNotEmpty()

    fun push(stateJson: String) {
        if (!DisplayBridge.isState(stateJson)) return
        last = stateJson
        ui.post { presentation?.push(stateJson) }
    }

    private fun sync() {
        val d = manager.getDisplays(DisplayManager.DISPLAY_CATEGORY_PRESENTATION).firstOrNull()
        if (d == null) { presentation?.dismiss(); presentation = null; return }
        if (presentation?.display?.displayId == d.displayId) return
        presentation?.dismiss()
        presentation = DisplayPresentation(context, d, url).also {
            try { it.show() } catch (_: Exception) { presentation = null; return }
            last?.let { s -> it.push(s) }
        }
    }
}
