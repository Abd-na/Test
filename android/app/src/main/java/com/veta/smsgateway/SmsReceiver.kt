package com.veta.smsgateway

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

/** Forwards every incoming SMS to the server (message.received webhook). */
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        if (!Prefs(context).isPaired) return
        val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        if (parts.isEmpty()) return

        // slot index extra differs between vendors
        val slot = listOf("slot", "simSlot", "slot_id", "android.telephony.extra.SLOT_INDEX")
            .map { intent.getIntExtra(it, -1) }
            .firstOrNull { it >= 0 }
        val sim = slot?.plus(1)

        // a long SMS arrives as several PDUs: join them per sender
        parts.filterNotNull().groupBy { it.displayOriginatingAddress ?: it.originatingAddress ?: "unknown" }
            .forEach { (from, pdus) ->
                val text = pdus.joinToString("") { it.displayMessageBody ?: it.messageBody ?: "" }
                val ts = pdus.first().timestampMillis
                PendingQueue.addInbox(context, from, text, ts, sim)
                GatewayState.countReceived()
                GatewayState.log("↓ رسالة من $from")
            }
        GatewayService.wake(context)
    }
}
