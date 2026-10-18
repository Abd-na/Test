package com.veta.smsgateway

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Foreground service that keeps a long-poll connection to the server, sends
 * the SMS it receives, and pushes status reports + incoming SMS back.
 */
class GatewayService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var pollJob: Job? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private val flushSignal = Channel<Unit>(Channel.CONFLATED)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        } else 0
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(getString(R.string.status_connecting)), type)
        wakeLock = (getSystemService(POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "VetaGateway::poll")
            .apply { setReferenceCounted(false); acquire() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_WAKE) {
            flushSignal.trySend(Unit)
        }
        if (pollJob?.isActive != true) startLoops()
        return START_STICKY
    }

    private fun startLoops() {
        val prefs = Prefs(this)
        if (!prefs.isPaired) {
            GatewayState.status(GatewayState.Status.ERROR, getString(R.string.not_paired))
            stopSelf()
            return
        }
        val api = ApiClient(prefs.serverUrl, prefs.token)
        var minDelayMs = 1500L
        var heartbeatSec = 30L

        pollJob = scope.launch {
            // heartbeat + flushing of pending reports
            launch {
                while (isActive) {
                    try {
                        val data = api.heartbeat(DeviceInfo.collect(this@GatewayService))
                        data.optJSONObject("config")?.let {
                            minDelayMs = it.optLong("min_delay_ms", minDelayMs)
                            heartbeatSec = it.optLong("heartbeat_sec", heartbeatSec)
                        }
                        val enabled = data.optJSONObject("device")?.optBoolean("enabled", true) ?: true
                        if (!enabled) GatewayState.status(GatewayState.Status.ERROR, getString(R.string.device_disabled))
                    } catch (e: ApiException) {
                        if (e.code == 401) {
                            GatewayState.status(GatewayState.Status.ERROR, getString(R.string.token_invalid))
                            GatewayState.log("✗ ${e.message}")
                        }
                    } catch (_: Exception) {
                        // network issue; the poll loop reports it
                    }
                    runCatching { PendingQueue.flush(this@GatewayService, api) }
                    withTimeoutOrNull(heartbeatSec * 1000) { flushSignal.receive() }
                }
            }

            // long-poll for SMS to send
            var backoff = 2000L
            while (isActive) {
                try {
                    GatewayState.status(GatewayState.Status.ONLINE, prefs.serverUrl)
                    updateNotification(getString(R.string.status_online))
                    val jobs = api.pollOutbox(waitSec = 25, limit = 5)
                    backoff = 2000L
                    for (job in jobs) {
                        try {
                            val route = SmsSender.send(this@GatewayService, job)
                            GatewayState.log("↑ إرسال إلى ${job.to} عبر $route")
                        } catch (e: Exception) {
                            PendingQueue.addStatus(this@GatewayService, job.id, "failed", e.message ?: "send error")
                            GatewayState.countFailed()
                            GatewayState.log("✗ ${job.to}: ${e.message}")
                        }
                        delay(minDelayMs)
                    }
                    if (jobs.isNotEmpty()) flushSignal.trySend(Unit)
                } catch (e: ApiException) {
                    val msg = if (e.code == 401) getString(R.string.token_invalid) else e.message ?: "error"
                    GatewayState.status(GatewayState.Status.ERROR, msg)
                    updateNotification(msg)
                    delay(if (e.code == 401) 60_000 else backoff)
                    backoff = (backoff * 2).coerceAtMost(60_000)
                } catch (e: Exception) {
                    GatewayState.status(GatewayState.Status.CONNECTING, e.message ?: "")
                    updateNotification(getString(R.string.status_reconnecting))
                    delay(backoff)
                    backoff = (backoff * 2).coerceAtMost(60_000)
                }
            }
        }
    }

    override fun onDestroy() {
        scope.cancel()
        wakeLock?.let { if (it.isHeld) it.release() }
        GatewayState.status(GatewayState.Status.STOPPED)
        super.onDestroy()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_gateway)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(open)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private var lastNotification = ""
    private fun updateNotification(text: String) {
        if (text == lastNotification) return
        lastNotification = text
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text))
    }

    companion object {
        private const val CHANNEL_ID = "gateway"
        private const val NOTIFICATION_ID = 1
        private const val ACTION_WAKE = "wake"

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, GatewayService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, GatewayService::class.java))
        }

        /** Asks a running service to flush pending reports right away. */
        fun wake(context: Context) {
            if (!Prefs(context).enabled) return
            runCatching {
                context.startService(Intent(context, GatewayService::class.java).setAction(ACTION_WAKE))
            }
        }
    }
}
