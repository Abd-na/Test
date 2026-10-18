package com.veta.smsgateway

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Required for the default SMS role. Downloading MMS (picture messages) is not
 * supported yet, so the user is told one arrived instead of it silently vanishing.
 */
class MmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        MessageNotifier.showPlain(
            context,
            id = 999,
            title = context.getString(R.string.mms_title),
            text = context.getString(R.string.mms_unsupported),
        )
    }
}
