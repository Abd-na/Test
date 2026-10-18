package com.veta.smsgateway

import android.Manifest
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.ContactsContract
import android.provider.Telephony
import androidx.core.content.ContextCompat
import java.util.concurrent.ConcurrentHashMap

/**
 * Reads and writes the phone's SMS store (Telephony provider), the same store
 * every messaging app uses. Writing is only allowed while this app is the
 * default SMS app; reading needs READ_SMS (or the default role).
 */
object SmsStore {
    private val names = ConcurrentHashMap<String, String>()

    fun isDefaultSmsApp(context: Context): Boolean =
        Telephony.Sms.getDefaultSmsPackage(context) == context.packageName

    private fun canRead(context: Context) =
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED

    /** Latest message per conversation, newest first. */
    fun threads(context: Context, scanLimit: Int = 5000): List<Map<String, Any?>> {
        if (!canRead(context)) return emptyList()
        val byThread = LinkedHashMap<Long, MutableMap<String, Any?>>()
        val projection = arrayOf(
            Telephony.Sms.THREAD_ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY,
            Telephony.Sms.DATE, Telephony.Sms.READ, Telephony.Sms.TYPE,
        )
        context.contentResolver.query(Telephony.Sms.CONTENT_URI, projection, null, null, "${Telephony.Sms.DATE} DESC")?.use { c ->
            var scanned = 0
            while (c.moveToNext() && scanned++ < scanLimit) {
                val threadId = c.getLong(0)
                val type = c.getInt(5)
                val unread = type == Telephony.Sms.MESSAGE_TYPE_INBOX && c.getInt(4) == 0
                val existing = byThread[threadId]
                if (existing == null) {
                    val address = c.getString(1).orEmpty()
                    byThread[threadId] = mutableMapOf(
                        "threadId" to threadId,
                        "address" to address,
                        "name" to contactName(context, address),
                        "snippet" to c.getString(2).orEmpty(),
                        "date" to c.getLong(3),
                        "lastType" to type,
                        "unread" to if (unread) 1 else 0,
                    )
                } else if (unread) {
                    existing["unread"] = (existing["unread"] as Int) + 1
                }
            }
        }
        return byThread.values.toList()
    }

    /** Messages of one conversation, oldest first (the newest [limit]). */
    fun messages(context: Context, threadId: Long, limit: Int = 300): List<Map<String, Any?>> {
        if (!canRead(context)) return emptyList()
        val out = ArrayList<Map<String, Any?>>()
        val projection = arrayOf(
            Telephony.Sms._ID, Telephony.Sms.BODY, Telephony.Sms.DATE,
            Telephony.Sms.TYPE, Telephony.Sms.STATUS, Telephony.Sms.ADDRESS,
        )
        context.contentResolver.query(
            Telephony.Sms.CONTENT_URI, projection, "${Telephony.Sms.THREAD_ID} = ?",
            arrayOf(threadId.toString()), "${Telephony.Sms.DATE} DESC",
        )?.use { c ->
            while (c.moveToNext() && out.size < limit) {
                out += mapOf(
                    "id" to c.getLong(0),
                    "body" to c.getString(1).orEmpty(),
                    "date" to c.getLong(2),
                    "type" to c.getInt(3),
                    "status" to c.getInt(4),
                    "address" to c.getString(5).orEmpty(),
                )
            }
        }
        return out.asReversed()
    }

    fun threadIdFor(context: Context, address: String): Long =
        Telephony.Threads.getOrCreateThreadId(context, address)

    /** Stores an incoming SMS (required from the default SMS app, or it is lost). */
    fun insertInbox(context: Context, address: String, body: String, sentAt: Long, subId: Int?): Uri? {
        val values = ContentValues().apply {
            put(Telephony.Sms.ADDRESS, address)
            put(Telephony.Sms.BODY, body)
            put(Telephony.Sms.DATE, System.currentTimeMillis())
            put(Telephony.Sms.DATE_SENT, sentAt)
            put(Telephony.Sms.READ, 0)
            put(Telephony.Sms.SEEN, 0)
            put(Telephony.Sms.TYPE, Telephony.Sms.MESSAGE_TYPE_INBOX)
            if (subId != null && subId >= 0) put(Telephony.Sms.SUBSCRIPTION_ID, subId)
        }
        return context.contentResolver.insert(Telephony.Sms.Inbox.CONTENT_URI, values)
    }

    /** Stores an outgoing SMS as "sending"; only possible as the default SMS app. */
    fun insertOutbox(context: Context, address: String, body: String, subId: Int?): Uri? {
        if (!isDefaultSmsApp(context)) return null // Android records it for us when we are not the default
        val values = ContentValues().apply {
            put(Telephony.Sms.ADDRESS, address)
            put(Telephony.Sms.BODY, body)
            put(Telephony.Sms.DATE, System.currentTimeMillis())
            put(Telephony.Sms.READ, 1)
            put(Telephony.Sms.SEEN, 1)
            put(Telephony.Sms.TYPE, Telephony.Sms.MESSAGE_TYPE_OUTBOX)
            put(Telephony.Sms.STATUS, Telephony.Sms.STATUS_PENDING)
            put(Telephony.Sms.THREAD_ID, threadIdFor(context, address))
            if (subId != null) put(Telephony.Sms.SUBSCRIPTION_ID, subId)
        }
        return runCatching { context.contentResolver.insert(Telephony.Sms.CONTENT_URI, values) }.getOrNull()
    }

    fun markSent(context: Context, uri: Uri, ok: Boolean, errorCode: Int = 0) {
        val values = ContentValues().apply {
            put(Telephony.Sms.TYPE, if (ok) Telephony.Sms.MESSAGE_TYPE_SENT else Telephony.Sms.MESSAGE_TYPE_FAILED)
            if (!ok) {
                put(Telephony.Sms.STATUS, Telephony.Sms.STATUS_FAILED)
                put(Telephony.Sms.ERROR_CODE, errorCode)
            }
        }
        runCatching { context.contentResolver.update(uri, values, null, null) }
    }

    fun markDelivered(context: Context, uri: Uri) {
        val values = ContentValues().apply { put(Telephony.Sms.STATUS, Telephony.Sms.STATUS_COMPLETE) }
        runCatching { context.contentResolver.update(uri, values, null, null) }
    }

    fun markThreadRead(context: Context, threadId: Long) {
        if (!isDefaultSmsApp(context)) return
        val values = ContentValues().apply {
            put(Telephony.Sms.READ, 1)
            put(Telephony.Sms.SEEN, 1)
        }
        runCatching {
            context.contentResolver.update(
                Telephony.Sms.CONTENT_URI, values,
                "${Telephony.Sms.THREAD_ID} = ? AND ${Telephony.Sms.READ} = 0", arrayOf(threadId.toString()),
            )
        }
    }

    fun deleteThread(context: Context, threadId: Long): Boolean {
        if (!isDefaultSmsApp(context)) return false
        return runCatching {
            context.contentResolver.delete(Telephony.Sms.CONTENT_URI, "${Telephony.Sms.THREAD_ID} = ?", arrayOf(threadId.toString()))
            true
        }.getOrDefault(false)
    }

    fun deleteMessage(context: Context, id: Long): Boolean {
        if (!isDefaultSmsApp(context)) return false
        return runCatching {
            context.contentResolver.delete(Uri.withAppendedPath(Telephony.Sms.CONTENT_URI, id.toString()), null, null) > 0
        }.getOrDefault(false)
    }

    fun unreadCount(context: Context, threadId: Long): Int {
        if (!canRead(context)) return 0
        return context.contentResolver.query(
            Telephony.Sms.Inbox.CONTENT_URI, arrayOf(Telephony.Sms._ID),
            "${Telephony.Sms.THREAD_ID} = ? AND ${Telephony.Sms.READ} = 0", arrayOf(threadId.toString()), null,
        )?.use { it.count } ?: 0
    }

    /** Contact name for a number, if READ_CONTACTS is granted. */
    fun contactName(context: Context, address: String): String? {
        if (address.isBlank()) return null
        names[address]?.let { return it.ifEmpty { null } }
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) {
            return null
        }
        val name = runCatching {
            val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(address))
            context.contentResolver.query(uri, arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)
                ?.use { if (it.moveToFirst()) it.getString(0) else null }
        }.getOrNull()
        names[address] = name.orEmpty()
        return name
    }

    fun clearNameCache() = names.clear()
}
