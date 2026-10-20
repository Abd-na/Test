package com.veta.smsgateway

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.telephony.SubscriptionManager
import org.json.JSONArray
import org.json.JSONObject

data class SimCard(val slot: Int, val subscriptionId: Int, val carrier: String)

object DeviceInfo {
    /** Active SIMs, slot numbers starting at 1. Empty without READ_PHONE_STATE. */
    @SuppressLint("MissingPermission")
    fun sims(context: Context): List<SimCard> = runCatching {
        context.getSystemService(SubscriptionManager::class.java)?.activeSubscriptionInfoList.orEmpty()
            .map { SimCard(it.simSlotIndex + 1, it.subscriptionId, it.carrierName?.toString() ?: "") }
            .sortedBy { it.slot }
    }.getOrDefault(emptyList())

    /** Heartbeat payload. With [sim] set only that SIM is reported (one server device per SIM). */
    fun collect(context: Context, sim: Int? = null): JSONObject {
        val info = JSONObject()
            .put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
            .put("app_version", BuildConfig.VERSION_NAME)

        val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        if (battery != null) {
            val level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
            if (level >= 0 && scale > 0) info.put("battery", level * 100 / scale)
            val plugged = battery.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0)
            info.put("charging", plugged != 0)
        }

        val sims = JSONArray()
        sims(context).filter { sim == null || it.slot == sim }.forEach { s ->
            sims.put(JSONObject().put("slot", s.slot).put("carrier", s.carrier))
        }
        info.put("sims", sims)
        return info
    }
}
