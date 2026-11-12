package com.rezein.hub

import android.content.Context
import android.content.SharedPreferences

/** What this tablet is linked to. Kept on the device. */
class Config(context: Context) {
    private val prefs: SharedPreferences = context.applicationContext.getSharedPreferences("hub", Context.MODE_PRIVATE)

    val baseUrl: String? get() = prefs.getString("baseUrl", null)
    val token: String? get() = prefs.getString("token", null)
    val name: String get() = prefs.getString("name", "Rezein") ?: "Rezein"
    val isLinked: Boolean get() = baseUrl != null && token != null

    /** Whether the hub should be running (so it comes back after a restart). */
    var wantRunning: Boolean
        get() = prefs.getBoolean("wantRunning", true)
        set(v) = prefs.edit().putBoolean("wantRunning", v).apply()

    fun link(baseUrl: String, token: String, name: String) {
        prefs.edit().putString("baseUrl", baseUrl).putString("token", token).putString("name", name).putBoolean("wantRunning", true).apply()
    }

    fun unlink() {
        prefs.edit().clear().apply()
    }
}

/** What the screen and the notification show. Written by the service, read by the screen. */
object HubState {
    @Volatile var running = false
    /** null = not tried yet. */
    @Volatile var online: Boolean? = null
    @Volatile var printed = 0
    @Volatile var failed = 0
    @Volatile var lastPrintedAt: Long = 0
    @Volatile var lastProblem: String? = null
    private val lines = ArrayDeque<String>()
    private val listeners = mutableListOf<() -> Unit>()

    @Synchronized fun log(message: String) {
        val t = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault()).format(java.util.Date())
        lines.addLast("$t  $message")
        while (lines.size > 40) lines.removeFirst()
        listeners.toList().forEach { it() }
    }

    @Synchronized fun recent(count: Int = 15): List<String> = lines.toList().takeLast(count).reversed()
    @Synchronized fun onChange(l: () -> Unit) { listeners.add(l) }
    @Synchronized fun removeListener(l: () -> Unit) { listeners.remove(l) }

    fun summary(): String = when {
        !running -> "Stopped"
        online == true -> "Connected. Waiting for orders"
        online == false -> "No connection to the shop. Retrying"
        else -> "Starting"
    }
}
