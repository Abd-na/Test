package com.veta.smsgateway

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.SmsManager
import android.telephony.SubscriptionManager
import androidx.core.content.ContextCompat
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

    /** Ids starting with this prefix are local tests from the app and are never reported to the server. */
    const val TEST_PREFIX = "test_"

    class SendException(message: String) : Exception(message)

    fun hasSendPermission(context: Context) =
        ContextCompat.checkSelfPermission(context, Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED

    /**
     * Picks the SIM explicitly. Relying on the "default" SmsManager fails on
     * dual-SIM phones set to "ask every time" (no default SMS SIM).
     * Order: requested slot → system default SMS SIM → first active SIM.
     */
    @SuppressLint("MissingPermission")
    private fun subscriptionFor(context: Context, sim: Int?): Pair<Int?, String> {
        val subs = context.getSystemService(SubscriptionManager::class.java)
        val active = runCatching { subs?.activeSubscriptionInfoList.orEmpty() }.getOrDefault(emptyList())
        if (sim != null) {
            active.firstOrNull { it.simSlotIndex == sim - 1 }?.let { return it.subscriptionId to "SIM$sim" }
        }
        val defaultSms = SubscriptionManager.getDefaultSmsSubscriptionId()
        if (defaultSms != SubscriptionManager.INVALID_SUBSCRIPTION_ID) {
            val slot = active.firstOrNull { it.subscriptionId == defaultSms }?.simSlotIndex
            return defaultSms to (if (slot != null) "SIM${slot + 1}" else "default SIM")
        }
        active.firstOrNull()?.let { return it.subscriptionId to "SIM${it.simSlotIndex + 1}" }
        return null to "default SIM"
    }

    private fun managerFor(context: Context, subId: Int?): SmsManager =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val base = context.getSystemService(SmsManager::class.java)
            if (subId != null) base.createForSubscriptionId(subId) else base
        } else {
            @Suppress("DEPRECATION")
            if (subId != null) SmsManager.getSmsManagerForSubscriptionId(subId) else SmsManager.getDefault()
        }

    private fun pending(context: Context, action: String, id: String): PendingIntent {
        val intent = Intent(context, SmsResultReceiver::class.java).setAction(action).putExtra(EXTRA_ID, id)
        // MUTABLE so the telephony stack can attach the delivery PDU / error code (explicit intent, so this is safe)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
        return PendingIntent.getBroadcast(context, requestCodes.incrementAndGet(), intent, flags)
    }

    /**
     * Hands the SMS to the radio and returns the SIM used (for the log).
     * Throws SendException with a readable reason if Android refuses it immediately.
     */
    fun send(context: Context, job: SmsJob): String {
        if (!hasSendPermission(context)) throw SendException("SEND_SMS permission is not granted on the phone")
        if (job.text.isEmpty()) throw SendException("empty message")
        val (subId, route) = subscriptionFor(context, job.sim)
        val manager = managerFor(context, subId)
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
        return route
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
