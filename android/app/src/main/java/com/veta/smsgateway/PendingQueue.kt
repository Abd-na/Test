package com.veta.smsgateway

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Status reports and incoming SMS waiting to reach the server. Persisted so
 * nothing is lost if the network is down or the app restarts.
 */
object PendingQueue {
    private const val FILE = "pending"
    private const val MAX = 2000

    private fun prefs(c: Context) = c.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    @Synchronized
    private fun read(c: Context, key: String) = JSONArray(prefs(c).getString(key, "[]"))

    @Synchronized
    private fun write(c: Context, key: String, arr: JSONArray) {
        // keep only the newest MAX entries
        val trimmed = if (arr.length() > MAX) JSONArray((arr.length() - MAX until arr.length()).map { arr.get(it) }) else arr
        prefs(c).edit().putString(key, trimmed.toString()).apply()
    }

    @Synchronized
    fun addStatus(c: Context, id: String, status: String, error: String? = null) {
        val arr = read(c, "statuses")
        arr.put(JSONObject().put("id", id).put("status", status).apply { if (error != null) put("error", error) })
        write(c, "statuses", arr)
    }

    @Synchronized
    fun addInbox(c: Context, from: String, text: String, receivedAt: Long, sim: Int?) {
        val arr = read(c, "inbox")
        arr.put(JSONObject().put("from", from).put("text", text).put("received_at", receivedAt).apply {
            if (sim != null) put("sim", sim)
        })
        write(c, "inbox", arr)
    }

    /** Sends everything queued; items that fail stay for the next try. */
    fun flush(c: Context, api: ApiClient) {
        val statuses = synchronized(this) { read(c, "statuses").also { write(c, "statuses", JSONArray()) } }
        val remaining = JSONArray()
        for (i in 0 until statuses.length()) {
            val o = statuses.getJSONObject(i)
            try {
                api.reportStatus(o.getString("id"), o.getString("status"), o.optString("error").ifBlank { null })
            } catch (e: ApiException) {
                if (e.code >= 500) remaining.put(o) // 4xx = server rejected it, drop
            } catch (e: Exception) {
                remaining.put(o)
            }
        }
        requeue(c, "statuses", remaining)

        val inbox = synchronized(this) { read(c, "inbox").also { write(c, "inbox", JSONArray()) } }
        if (inbox.length() > 0) {
            try {
                api.pushInbox(inbox)
            } catch (e: ApiException) {
                if (e.code >= 500) requeue(c, "inbox", inbox)
            } catch (e: Exception) {
                requeue(c, "inbox", inbox)
            }
        }
    }

    @Synchronized
    private fun requeue(c: Context, key: String, items: JSONArray) {
        if (items.length() == 0) return
        val current = read(c, key)
        for (i in 0 until current.length()) items.put(current.get(i))
        write(c, key, items)
    }

    fun size(c: Context) = read(c, "statuses").length() + read(c, "inbox").length()
}
