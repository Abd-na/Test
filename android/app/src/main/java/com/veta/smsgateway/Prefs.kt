package com.veta.smsgateway

import android.content.Context

/** Persisted pairing data and the on/off switch. */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("gateway", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = sp.getString("server_url", "") ?: ""
        set(value) = sp.edit().putString("server_url", value.trim().trimEnd('/')).apply()

    var token: String
        get() = sp.getString("token", "") ?: ""
        set(value) = sp.edit().putString("token", value.trim()).apply()

    var deviceName: String
        get() = sp.getString("device_name", "") ?: ""
        set(value) = sp.edit().putString("device_name", value).apply()

    var enabled: Boolean
        get() = sp.getBoolean("enabled", false)
        set(value) = sp.edit().putBoolean("enabled", value).apply()

    val isPaired: Boolean
        get() = serverUrl.isNotBlank() && token.isNotBlank()

    fun clearPairing() {
        sp.edit().remove("server_url").remove("token").remove("device_name").putBoolean("enabled", false).apply()
    }
}
