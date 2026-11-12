package com.rezein.hub

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/** Keeps the hub running in the background, with a notification, and keeps the tablet awake enough to do it. */
class HubService : Service() {
    private var worker: Thread? = null
    @Volatile private var stopping = false
    private var wake: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null
    private val refresh: () -> Unit = { updateNotification() }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val config = Config(this)
        if (intent?.action == ACTION_STOP || !config.isLinked) {
            config.wantRunning = false
            stopSelf()
            return START_NOT_STICKY
        }
        config.wantRunning = true
        createChannel()
        startForeground(NOTIFICATION_ID, buildNotification())
        if (worker?.isAlive != true) {
            stopping = false
            acquireLocks()
            HubState.running = true
            HubState.onChange(refresh)
            HubState.log("Hub started for ${config.baseUrl}")
            if (config.smsNumber.isNotEmpty()) Thread { try { HubClient(config.baseUrl!!, config.token!!).setSmsNumber(config.smsNumber) } catch (_: Exception) {} }.start()
            worker = Thread({ loop(config.baseUrl!!, config.token!!) }, "hub-loop").also { it.isDaemon = true; it.start() }
        }
        return START_STICKY
    }

    private fun loop(baseUrl: String, token: String) {
        val client = HubClient(baseUrl, token, log = { HubState.log(it) })
        var wait = 0L
        while (!stopping) {
            try {
                val r = client.runOnce()
                if (HubState.online != true) HubState.log("Connected to the shop")
                HubState.online = true
                HubState.lastProblem = null
                wait = 0
                if (r.delivered > 0) { HubState.printed += r.delivered; HubState.lastPrintedAt = System.currentTimeMillis() }
                if (r.failed > 0) { HubState.failed += r.failed; HubState.lastProblem = "A printer did not take a job"; sleep(3000) }
                updateNotification()
                sleep(2000)
            } catch (e: InterruptedException) {
                return
            } catch (e: Exception) {
                val message = e.message ?: e.javaClass.simpleName
                if (HubState.online != false) HubState.log("!! Cannot reach the shop: $message. Will keep trying; nothing is lost.")
                HubState.online = false
                HubState.lastProblem = message
                updateNotification()
                wait = if (e is NotLinked) 60_000 else minOf(if (wait == 0L) 2000 else wait * 2, 30_000)
                sleep(wait)
            }
        }
    }

    private fun sleep(ms: Long) {
        try { Thread.sleep(ms) } catch (e: InterruptedException) { stopping = true }
    }

    override fun onDestroy() {
        stopping = true
        worker?.interrupt()
        HubState.running = false
        HubState.removeListener(refresh)
        HubState.log("Hub stopped")
        releaseLocks()
        super.onDestroy()
    }

    private fun acquireLocks() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "rezein:hub").also { it.setReferenceCounted(false); it.acquire() }
        val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        @Suppress("DEPRECATION")
        wifi = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "rezein:hub").also { it.setReferenceCounted(false); it.acquire() }
    }

    private fun releaseLocks() {
        try { if (wake?.isHeld == true) wake?.release() } catch (_: Exception) {}
        try { if (wifi?.isHeld == true) wifi?.release() } catch (_: Exception) {}
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Rezein", NotificationManager.IMPORTANCE_LOW))
        }
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val text = "${HubState.summary()}. Printed ${HubState.printed}" + (if (HubState.failed > 0) ", ${HubState.failed} failed" else "")
        return Notification.Builder(this, CHANNEL)
            .setContentTitle("Rezein")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setContentIntent(open)
            .build()
    }

    private fun updateNotification() {
        try { getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification()) } catch (_: Exception) {}
    }

    companion object {
        const val CHANNEL = "hub"
        const val NOTIFICATION_ID = 1
        const val ACTION_STOP = "com.rezein.hub.STOP"

        fun start(context: Context) {
            val i = Intent(context, HubService::class.java)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i) else context.startService(i)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, HubService::class.java).setAction(ACTION_STOP))
        }
    }
}
