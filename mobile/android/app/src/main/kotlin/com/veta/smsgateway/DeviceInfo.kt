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

object DeviceInfo {
    @SuppressLint("MissingPermission")
    fun collect(context: Context): JSONObject {
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

        runCatching {
            val subs = context.getSystemService(SubscriptionManager::class.java)?.activeSubscriptionInfoList.orEmpty()
            val sims = JSONArray()
            subs.forEach { s ->
                sims.put(JSONObject().put("slot", s.simSlotIndex + 1).put("carrier", s.carrierName?.toString() ?: ""))
            }
            info.put("sims", sims)
        }
        return info
    }
}
