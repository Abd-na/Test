package com.veta.smsgateway

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.telephony.SubscriptionManager

/**
 * SMS_DELIVER goes only to the default SMS app. Android no longer stores the
 * message itself, so we must write it to the SMS store or it is lost.
 * (Forwarding to the server is done separately by SmsReceiver on SMS_RECEIVED.)
 */
class SmsDeliverReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_DELIVER_ACTION) return
        val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent)?.filterNotNull().orEmpty()
        if (parts.isEmpty()) return
        val subId = intent.getIntExtra(SubscriptionManager.EXTRA_SUBSCRIPTION_INDEX, intent.getIntExtra("subscription", -1))

        parts.groupBy { it.displayOriginatingAddress ?: it.originatingAddress ?: "unknown" }
            .forEach { (from, pdus) ->
                val body = pdus.joinToString("") { it.displayMessageBody ?: it.messageBody ?: "" }
                val uri = SmsStore.insertInbox(context, from, body, pdus.first().timestampMillis, subId.takeIf { it >= 0 })
                val threadId = runCatching { SmsStore.threadIdFor(context, from) }.getOrDefault(0L)
                if (uri == null) GatewayState.log("✗ تعذر حفظ رسالة واردة من $from")
                MessageNotifier.showIncoming(context, threadId, from, body)
            }
    }
}
