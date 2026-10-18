package com.veta.smsgateway

import android.app.Service
import android.content.Intent
import android.os.IBinder

/** Quick replies from the incoming-call screen ("Can't talk now"). Required for the default SMS role. */
class RespondViaMessageService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val address = intent?.data?.schemeSpecificPart?.substringBefore('?')?.trim().orEmpty()
        val text = intent?.getStringExtra(Intent.EXTRA_TEXT).orEmpty()
        if (address.isNotEmpty() && text.isNotEmpty()) {
            runCatching {
                SmsSender.send(this, SmsJob(id = "${SmsSender.UI_PREFIX}${System.currentTimeMillis()}", to = address, text = text, sim = null))
            }
        }
        stopSelf(startId)
        return START_NOT_STICKY
    }
}
