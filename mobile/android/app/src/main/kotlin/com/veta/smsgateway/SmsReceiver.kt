package com.veta.smsgateway

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

/** Forwards every incoming SMS to the server device paired with the SIM it arrived on (message.received webhook). */
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val prefs = Prefs(context)
        if (!prefs.isPaired) return
        val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        if (parts.isEmpty()) return

        val sim = simSlot(context, intent)
        val pairing = Lines.forIncoming(prefs, sim)
        if (pairing == null) {
            GatewayState.log("↓ رسالة على SIM$sim — هذه الشريحة غير مربوطة، لن تُرفع")
            return
        }
        val tag = Lines.label(pairing.line).let { if (it.isEmpty()) "" else "[$it] " }

        // a long SMS arrives as several PDUs: join them per sender
        parts.filterNotNull().groupBy { it.displayOriginatingAddress ?: it.originatingAddress ?: "unknown" }
            .forEach { (from, pdus) ->
                val text = pdus.joinToString("") { it.displayMessageBody ?: it.messageBody ?: "" }
                val ts = pdus.first().timestampMillis
                PendingQueue.addInbox(context, pairing.line, from, text, ts, sim)
                GatewayState.countReceived()
                GatewayState.log("$tag↓ رسالة من $from")
            }
        GatewayService.wake(context)
    }

    companion object {
        /** SIM slot (1-based) the SMS arrived on, or null if the vendor doesn't say. */
        fun simSlot(context: Context, intent: Intent): Int? {
            // slot index extra differs between vendors
            listOf("android.telephony.extra.SLOT_INDEX", "slot", "simSlot", "slot_id", "phone")
                .map { intent.getIntExtra(it, -1) }
                .firstOrNull { it >= 0 }
                ?.let { return it + 1 }
            // otherwise map the subscription id to its slot
            val subId = listOf("android.telephony.extra.SUBSCRIPTION_INDEX", "subscription")
                .map { intent.getIntExtra(it, -1) }
                .firstOrNull { it >= 0 } ?: return null
            return DeviceInfo.sims(context).firstOrNull { it.subscriptionId == subId }?.slot
        }
    }
}
