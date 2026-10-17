package com.veta.smsgateway

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.telephony.SmsManager
import android.telephony.SubscriptionManager
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/** Sends SMS through the phone's SIM, tracking multipart results per message. */
object SmsSender {
    const val ACTION_SENT = "com.veta.smsgateway.SMS_SENT"
    const val ACTION_DELIVERED = "com.veta.smsgateway.SMS_DELIVERED"
    const val EXTRA_ID = "message_id"

    private val requestCodes = AtomicInteger((System.currentTimeMillis() % 100000).toInt())
    private val remainingParts = ConcurrentHashMap<String, Int>()
    private val firstError = ConcurrentHashMap<String, String>()

    @SuppressLint("MissingPermission")
    private fun managerFor(context: Context, sim: Int?): SmsManager {
        var subId: Int? = null
        if (sim != null) {
            val subs = context.getSystemService(SubscriptionManager::class.java)
            subId = runCatching {
                subs?.activeSubscriptionInfoList?.firstOrNull { it.simSlotIndex == sim - 1 }?.subscriptionId
            }.getOrNull()
        }
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val base = context.getSystemService(SmsManager::class.java)
            if (subId != null) base.createForSubscriptionId(subId) else base
        } else {
            @Suppress("DEPRECATION")
            if (subId != null) SmsManager.getSmsManagerForSubscriptionId(subId) else SmsManager.getDefault()
        }
    }

    private fun pending(context: Context, action: String, id: String): PendingIntent {
        val intent = Intent(context, SmsResultReceiver::class.java).setAction(action).putExtra(EXTRA_ID, id)
        // MUTABLE so the telephony stack can attach the delivery PDU / error code (explicit intent, so this is safe)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
        return PendingIntent.getBroadcast(context, requestCodes.incrementAndGet(), intent, flags)
    }

    /** Hands the SMS to the radio. Throws if Android refuses it immediately. */
    fun send(context: Context, job: SmsJob) {
        val manager = managerFor(context, job.sim)
        val parts = manager.divideMessage(job.text)
        remainingParts[job.id] = parts.size
        firstError.remove(job.id)
        if (parts.size == 1) {
            manager.sendTextMessage(job.to, null, job.text, pending(context, ACTION_SENT, job.id), pending(context, ACTION_DELIVERED, job.id))
        } else {
            val sent = ArrayList(parts.map { pending(context, ACTION_SENT, job.id) })
            // delivery report only for the last part
            val delivered = ArrayList(parts.indices.map { i -> if (i == parts.size - 1) pending(context, ACTION_DELIVERED, job.id) else null })
            manager.sendMultipartTextMessage(job.to, null, parts, sent, delivered)
        }
    }

    /**
     * Called for each sent part. Returns the final outcome once all parts are
     * done: null while parts are pending, "" on success, or the error text.
     */
    fun onPartResult(id: String, error: String?): String? {
        if (error != null) firstError.putIfAbsent(id, error)
        val left = remainingParts.compute(id) { _, v -> (v ?: 1) - 1 } ?: 0
        if (left > 0) return null
        remainingParts.remove(id)
        return firstError.remove(id) ?: ""
    }
}
