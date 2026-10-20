package com.veta.smsgateway

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.telephony.SmsManager
import android.telephony.SmsMessage

/** Receives the radio's sent / delivered callbacks and reports them to the server. */
class SmsResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra(SmsSender.EXTRA_ID) ?: return
        val storeUri = intent.getStringExtra(SmsSender.EXTRA_URI)?.let(Uri::parse)
        val line = intent.getStringExtra(SmsSender.EXTRA_LINE) ?: Prefs.ANY
        if (SmsSender.isLocal(id)) {
            onLocalResult(context, intent, id, storeUri)
            return
        }
        when (intent.action) {
            SmsSender.ACTION_SENT -> {
                val error = if (resultCode == Activity.RESULT_OK) null else describe(resultCode, intent)
                val outcome = SmsSender.onPartResult(id, error) ?: return
                storeUri?.let { SmsStore.markSent(context, it, outcome.isEmpty(), resultCode) }
                if (outcome.isEmpty()) {
                    PendingQueue.addStatus(context, line, id, "sent")
                    GatewayState.countSent()
                    GatewayState.log("✓ أُرسلت $id")
                } else {
                    PendingQueue.addStatus(context, line, id, "failed", outcome)
                    GatewayState.countFailed()
                    GatewayState.log("✗ فشل $id: $outcome")
                }
            }
            SmsSender.ACTION_DELIVERED -> {
                if (isDelivered(intent)) {
                    storeUri?.let { SmsStore.markDelivered(context, it) }
                    PendingQueue.addStatus(context, line, id, "delivered")
                    GatewayState.log("✓✓ وصلت $id")
                }
            }
        }
        GatewayService.wake(context)
    }

    /** Test button / chat screen messages: update the SMS store and the log, never the server. */
    private fun onLocalResult(context: Context, intent: Intent, id: String, storeUri: Uri?) {
        val test = id.startsWith(SmsSender.TEST_PREFIX)
        when (intent.action) {
            SmsSender.ACTION_SENT -> {
                val error = if (resultCode == Activity.RESULT_OK) null else describe(resultCode, intent)
                val outcome = SmsSender.onPartResult(id, error) ?: return
                storeUri?.let { SmsStore.markSent(context, it, outcome.isEmpty(), resultCode) }
                if (test) {
                    GatewayState.log(if (outcome.isEmpty()) "✓ الرسالة التجريبية أُرسلت من الشريحة" else "✗ الرسالة التجريبية فشلت: $outcome")
                }
            }
            SmsSender.ACTION_DELIVERED -> if (isDelivered(intent)) {
                storeUri?.let { SmsStore.markDelivered(context, it) }
                if (test) GatewayState.log("✓✓ الرسالة التجريبية وصلت للمستلم")
            }
        }
    }

    private fun isDelivered(intent: Intent): Boolean {
        val pdu = intent.getByteArrayExtra("pdu") ?: return resultCode == Activity.RESULT_OK
        val format = intent.getStringExtra("format")
        val status = runCatching { SmsMessage.createFromPdu(pdu, format).status }.getOrNull() ?: return true
        // GSM TP-Status: 0x00-0x1F completed; CDMA uses a different encoding where 0 also means delivered
        return status in 0..0x1F
    }

    private fun describe(code: Int, intent: Intent): String {
        val reason = when (code) {
            SmsManager.RESULT_ERROR_GENERIC_FAILURE -> "generic failure"
            SmsManager.RESULT_ERROR_NO_SERVICE -> "no service"
            SmsManager.RESULT_ERROR_NULL_PDU -> "null PDU"
            SmsManager.RESULT_ERROR_RADIO_OFF -> "radio off (airplane mode?)"
            SmsManager.RESULT_ERROR_LIMIT_EXCEEDED -> "sending limit exceeded"
            SmsManager.RESULT_ERROR_SHORT_CODE_NOT_ALLOWED -> "short code not allowed"
            SmsManager.RESULT_ERROR_SHORT_CODE_NEVER_ALLOWED -> "short code never allowed"
            else -> "error $code"
        }
        val radioCode = intent.getIntExtra("errorCode", -1)
        return if (radioCode > 0) "$reason (radio $radioCode)" else reason
    }
}
