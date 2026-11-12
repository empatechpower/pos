package com.rezein.hub

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Starts the hub again after the tablet restarts, or after the app is updated, if it was running. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val config = Config(context)
        if (config.isLinked && config.wantRunning) {
            try { HubService.start(context) } catch (_: Exception) { /* Android may refuse; opening the app starts it */ }
        }
    }
}
