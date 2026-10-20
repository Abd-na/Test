package com.veta.smsgateway

import android.content.Context
import org.json.JSONObject

/** One server pairing. [line] is "any" (all SIMs) or a SIM slot number "1", "2"… */
data class Pairing(val line: String, val serverUrl: String, val token: String, val deviceName: String) {
    /** SIM slot this pairing is bound to, or null when it may use any SIM. */
    val sim: Int? get() = line.toIntOrNull()
}

/**
 * Persisted pairings and the on/off switch. A dual-SIM phone can be paired
 * once per SIM, so each SIM acts as its own device on the server.
 */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("gateway", Context.MODE_PRIVATE)

    init {
        migrateSinglePairing()
    }

    var enabled: Boolean
        get() = sp.getBoolean("enabled", false)
        set(value) = sp.edit().putBoolean("enabled", value).apply()

    val pairings: List<Pairing>
        get() {
            val all = JSONObject(sp.getString("pairings", "{}") ?: "{}")
            return all.keys().asSequence().map { line ->
                val o = all.getJSONObject(line)
                Pairing(line, o.optString("url"), o.optString("token"), o.optString("name"))
            }.filter { it.serverUrl.isNotBlank() && it.token.isNotBlank() }
                .sortedBy { it.sim ?: 0 }
                .toList()
        }

    val isPaired: Boolean get() = pairings.isNotEmpty()

    fun pairing(line: String) = pairings.firstOrNull { it.line == line }

    @Synchronized
    fun savePairing(line: String, url: String, token: String, name: String) {
        val all = JSONObject(sp.getString("pairings", "{}") ?: "{}")
        all.put(line, JSONObject().put("url", url.trim().trimEnd('/')).put("token", token.trim()).put("name", name))
        sp.edit().putString("pairings", all.toString()).apply()
    }

    @Synchronized
    fun clearPairing(line: String) {
        val all = JSONObject(sp.getString("pairings", "{}") ?: "{}")
        all.remove(line)
        sp.edit().putString("pairings", all.toString()).apply()
        if (all.length() == 0) enabled = false
    }

    /** Versions before dual-SIM support stored a single pairing: keep it as the "any SIM" line. */
    private fun migrateSinglePairing() {
        val url = sp.getString("server_url", null) ?: return
        val token = sp.getString("token", "").orEmpty()
        if (url.isNotBlank() && token.isNotBlank()) {
            savePairing(ANY, url, token, sp.getString("device_name", "").orEmpty())
        }
        sp.edit().remove("server_url").remove("token").remove("device_name").apply()
    }

    companion object {
        const val ANY = "any"
    }
}
