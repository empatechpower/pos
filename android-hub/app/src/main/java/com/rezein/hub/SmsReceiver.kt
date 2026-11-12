package com.rezein.hub

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

/**
 * A text arrived on this tablet's SIM. Customers sign in by texting the code the shop page shows them, so it is passed to
 * the shop, which matches the sender's number and the code to the person waiting. Nothing is kept on the tablet.
 */
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val config = Config(context)
        if (!config.isLinked) return
        // One long text arrives in parts: put each sender's parts back together.
        val texts = Telephony.Sms.Intents.getMessagesFromIntent(intent)
            .filter { it.originatingAddress != null }
            .groupBy({ it.originatingAddress!! }, { it.messageBody ?: "" })
            .mapValues { it.value.joinToString("") }
        if (texts.isEmpty()) return
        val pending = goAsync()
        Thread {
            try {
                val client = HubClient(config.baseUrl!!, config.token!!)
                for ((from, body) in texts) forward(client, from, body)
            } finally {
                pending.finish()
            }
        }.start()
    }

    private fun forward(client: HubClient, from: String, body: String) {
        for (attempt in 1..4) {
            try {
                if (client.forwardSms(from, body)) {
                    HubState.log("Text from ${mask(from)} passed to the shop")
                    return
                }
            } catch (e: NotLinked) {
                HubState.log("Text not passed on: this tablet is not linked")
                return
            } catch (e: Exception) {
                // try again below
            }
            Thread.sleep(1000L * attempt)
        }
        HubState.log("Could not pass a text from ${mask(from)} to the shop")
    }

    private fun mask(n: String) = if (n.length > 6) n.take(4) + "..." + n.takeLast(2) else n
}
