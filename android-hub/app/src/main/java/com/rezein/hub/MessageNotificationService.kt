package com.rezein.hub

import android.app.Notification
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * Chat (RCS) messages do not arrive as ordinary SMS, so the SMS receiver never sees them. They do show as a notification in the
 * Messages app, and this reads that notification when the person has allowed notification access. A customer's sign-in code
 * is passed to the shop exactly as an SMS would be. Nothing else is read, stored or kept.
 */
class MessageNotificationService : NotificationListenerService() {
    private val seen = LinkedHashMap<String, Long>()

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName !in MESSAGING_APPS) return
        val config = Config(applicationContext)
        if (!config.isLinked) return
        val extras = sbn.notification.extras ?: return
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
        val lines = mutableListOf<String?>()
        val senders = mutableListOf<String?>()
        lines += extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()
        senders += null
        lines += extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
        senders += null
        extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)?.forEach { lines += it?.toString(); senders += null }
        @Suppress("DEPRECATION")
        (extras.getParcelableArray(Notification.EXTRA_MESSAGES))?.forEach { p ->
            val b = p as? Bundle ?: return@forEach
            lines += b.getCharSequence("text")?.toString()
            senders += b.getCharSequence("sender")?.toString()
        }
        val found = ChatParser.fromNotification(title, lines, senders)
        if (found.isEmpty()) return
        val now = System.currentTimeMillis()
        synchronized(seen) {
            seen.entries.removeAll { now - it.value > 10 * 60_000 }
            val fresh = found.filter { (f, c) -> seen.putIfAbsent("$f:$c", now) == null }
            if (fresh.isEmpty()) return
            Thread {
                val client = HubClient(config.baseUrl!!, config.token!!)
                for ((from, code) in fresh) {
                    var done = false
                    for (attempt in 1..4) {
                        try { if (client.forwardSms(from, code, partial = !from.startsWith("+"))) { done = true; break } } catch (e: NotLinked) { break } catch (_: Exception) { }
                        Thread.sleep(1000L * attempt)
                    }
                    HubState.log(if (done) "Chat message from ${from.take(4)}... passed to the shop" else "Could not pass a chat message to the shop")
                }
            }.start()
        }
    }

    companion object {
        val MESSAGING_APPS = setOf(
            "com.google.android.apps.messaging",
            "com.samsung.android.messaging",
            "com.android.mms",
            "com.android.messaging",
            "com.oneplus.mms",
            "com.miui.mms",
        )
    }
}
