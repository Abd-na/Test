package com.veta.smsgateway

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Status reports and incoming SMS waiting to reach the server. Persisted so
 * nothing is lost if the network is down or the app restarts. Each line (SIM
 * pairing) has its own queue since it reports to its own server device.
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

    /** The "any SIM" line keeps the keys used before dual-SIM support, so nothing queued is lost on update. */
    private fun key(kind: String, line: String) = if (line == Prefs.ANY) kind else "${kind}_$line"

    @Synchronized
    fun addStatus(c: Context, line: String, id: String, status: String, error: String? = null) {
        val k = key("statuses", line)
        val arr = read(c, k)
        arr.put(JSONObject().put("id", id).put("status", status).apply { if (error != null) put("error", error) })
        write(c, k, arr)
    }

    @Synchronized
    fun addInbox(c: Context, line: String, from: String, text: String, receivedAt: Long, sim: Int?) {
        val k = key("inbox", line)
        val arr = read(c, k)
        arr.put(JSONObject().put("from", from).put("text", text).put("received_at", receivedAt).apply {
            if (sim != null) put("sim", sim)
        })
        write(c, k, arr)
    }

    /** Sends everything queued for [line]; items that fail stay for the next try. */
    fun flush(c: Context, line: String, api: ApiClient) {
        val statusKey = key("statuses", line)
        val inboxKey = key("inbox", line)
        val statuses = synchronized(this) { read(c, statusKey).also { write(c, statusKey, JSONArray()) } }
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
        requeue(c, statusKey, remaining)

        val inbox = synchronized(this) { read(c, inboxKey).also { write(c, inboxKey, JSONArray()) } }
        if (inbox.length() > 0) {
            try {
                api.pushInbox(inbox)
            } catch (e: ApiException) {
                if (e.code >= 500) requeue(c, inboxKey, inbox)
            } catch (e: Exception) {
                requeue(c, inboxKey, inbox)
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

    fun size(c: Context) = Prefs(c).pairings.sumOf { p ->
        read(c, key("statuses", p.line)).length() + read(c, key("inbox", p.line)).length()
    }

    /** Drops what is queued for a line that was unpaired (its server device can't take it anymore). */
    @Synchronized
    fun clear(c: Context, line: String) {
        prefs(c).edit().remove(key("statuses", line)).remove(key("inbox", line)).apply()
    }
}
