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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Foreground service that keeps a long-poll connection to the server, sends
 * the SMS it receives, and pushes status reports + incoming SMS back.
 * Each pairing (one per SIM on dual-SIM phones) gets its own loops, so every
 * SIM works as a separate device on the server.
 */
class GatewayService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var pollJob: Job? = null
    private var wakeLock: PowerManager.WakeLock? = null
    /** Bumped to make every line flush its pending reports right away. */
    private val flushTick = MutableStateFlow(0L)

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
        when (intent?.action) {
            ACTION_WAKE -> flushTick.update { it + 1 }
            ACTION_RELOAD -> {
                // pairings changed: restart the loops with the new set
                pollJob?.cancel()
                pollJob = null
            }
        }
        if (pollJob?.isActive != true) startLoops()
        return START_STICKY
    }

    private fun startLoops() {
        val pairings = Prefs(this).pairings
        if (pairings.isEmpty()) {
            GatewayState.status(GatewayState.Status.ERROR, getString(R.string.not_paired))
            stopSelf()
            return
        }
        GatewayState.status(GatewayState.Status.CONNECTING)
        pollJob = scope.launch {
            pairings.forEach { pairing -> launch { runLine(pairing) } }
        }
    }

    private suspend fun runLine(pairing: Pairing) = coroutineScope {
        val api = ApiClient(pairing.serverUrl, pairing.token)
        val line = pairing.line
        val tag = Lines.label(line).let { if (it.isEmpty()) "" else "[$it] " }
        var minDelayMs = 1500L
        var heartbeatSec = 30L

        // heartbeat + flushing of pending reports
        launch {
            while (isActive) {
                try {
                    val data = api.heartbeat(DeviceInfo.collect(this@GatewayService, pairing.sim))
                    data.optJSONObject("config")?.let {
                        minDelayMs = it.optLong("min_delay_ms", minDelayMs)
                        heartbeatSec = it.optLong("heartbeat_sec", heartbeatSec)
                    }
                    val enabled = data.optJSONObject("device")?.optBoolean("enabled", true) ?: true
                    if (!enabled) GatewayState.lineStatus(line, GatewayState.Status.ERROR, getString(R.string.device_disabled))
                } catch (e: ApiException) {
                    ensureActive()
                    if (e.code == 401) {
                        GatewayState.lineStatus(line, GatewayState.Status.ERROR, getString(R.string.token_invalid))
                        GatewayState.log("$tag✗ ${e.message}")
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // network issue; the poll loop reports it
                }
                val seen = flushTick.value
                runCatching { PendingQueue.flush(this@GatewayService, line, api) }
                withTimeoutOrNull(heartbeatSec * 1000) { flushTick.first { it != seen } }
            }
        }

        // long-poll for SMS to send
        var backoff = 2000L
        while (isActive) {
            try {
                GatewayState.lineStatus(line, GatewayState.Status.ONLINE, pairing.serverUrl)
                refreshNotification()
                val jobs = api.pollOutbox(waitSec = 25, limit = 5)
                backoff = 2000L
                for (job in jobs) {
                    try {
                        val route = SmsSender.send(this@GatewayService, job, line)
                        GatewayState.log("$tag↑ إرسال إلى ${job.to} عبر $route")
                    } catch (e: Exception) {
                        PendingQueue.addStatus(this@GatewayService, line, job.id, "failed", e.message ?: "send error")
                        GatewayState.countFailed()
                        GatewayState.log("$tag✗ ${job.to}: ${e.message}")
                    }
                    delay(minDelayMs)
                }
                if (jobs.isNotEmpty()) flushTick.update { it + 1 }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                ensureActive() // a reloaded (unpaired) line must not report anymore
                val msg = if (e.code == 401) getString(R.string.token_invalid) else e.message ?: "error"
                GatewayState.lineStatus(line, GatewayState.Status.ERROR, msg)
                refreshNotification()
                delay(if (e.code == 401) 60_000 else backoff)
                backoff = (backoff * 2).coerceAtMost(60_000)
            } catch (e: Exception) {
                ensureActive()
                GatewayState.lineStatus(line, GatewayState.Status.CONNECTING, e.message ?: "")
                refreshNotification()
                delay(backoff)
                backoff = (backoff * 2).coerceAtMost(60_000)
            }
        }
    }

    /** Notification text from the overall state (online if any SIM is online). */
    private fun refreshNotification() {
        val s = GatewayState.state.value
        updateNotification(
            when (s.status) {
                GatewayState.Status.ONLINE -> getString(R.string.status_online)
                GatewayState.Status.ERROR -> s.detail.ifBlank { getString(R.string.status_reconnecting) }
                else -> getString(R.string.status_reconnecting)
            },
        )
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
        private const val ACTION_RELOAD = "reload"

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, GatewayService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, GatewayService::class.java))
        }

        /** Applies changed pairings: restarts the loops, or stops when nothing is left to run. */
        fun reload(context: Context) {
            val prefs = Prefs(context)
            if (prefs.enabled && prefs.isPaired) {
                ContextCompat.startForegroundService(
                    context, Intent(context, GatewayService::class.java).setAction(ACTION_RELOAD),
                )
            } else {
                stop(context)
            }
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
