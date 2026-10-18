package com.veta.smsgateway

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Hosts the Flutter UI and exposes the native gateway to it:
 *  - MethodChannel "veta/gateway": pair / unpair / start / stop / battery settings
 *  - EventChannel  "veta/gateway/events": live status snapshots
 */
class MainActivity : FlutterActivity() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var eventsJob: Job? = null
    private val prefs by lazy { Prefs(this) }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val messenger = flutterEngine.dartExecutor.binaryMessenger

        MethodChannel(messenger, "veta/gateway").setMethodCallHandler { call, result ->
            when (call.method) {
                "getState" -> result.success(snapshot())
                "pair" -> {
                    val url = call.argument<String>("url").orEmpty()
                    val token = call.argument<String>("token").orEmpty()
                    if (url.isBlank() || token.isBlank()) {
                        result.error("invalid", "url and token are required", null)
                        return@setMethodCallHandler
                    }
                    GatewayService.stop(this)
                    prefs.serverUrl = url
                    prefs.token = token
                    prefs.deviceName = call.argument<String>("name").orEmpty()
                    GatewayState.log("✓ تم الربط مع $url")
                    GatewayState.touch()
                    result.success(null)
                }
                "unpair" -> {
                    GatewayService.stop(this)
                    prefs.clearPairing()
                    GatewayState.touch()
                    result.success(null)
                }
                "start" -> {
                    if (!prefs.isPaired) {
                        result.error("not_paired", getString(R.string.not_paired), null)
                        return@setMethodCallHandler
                    }
                    prefs.enabled = true
                    GatewayService.start(this)
                    GatewayState.touch()
                    result.success(null)
                }
                "stop" -> {
                    prefs.enabled = false
                    GatewayService.stop(this)
                    GatewayState.touch()
                    result.success(null)
                }
                "isIgnoringBattery" -> result.success(isIgnoringBattery())
                "requestIgnoreBattery" -> {
                    requestBatteryExemption()
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }

        EventChannel(messenger, "veta/gateway/events").setStreamHandler(object : EventChannel.StreamHandler {
            override fun onListen(arguments: Any?, events: EventChannel.EventSink) {
                eventsJob?.cancel()
                eventsJob = scope.launch {
                    GatewayState.state.collect { events.success(snapshot()) }
                }
            }

            override fun onCancel(arguments: Any?) {
                eventsJob?.cancel()
            }
        })

        if (prefs.enabled && prefs.isPaired) GatewayService.start(this)
    }

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        scope.cancel()
        super.cleanUpFlutterEngine(flutterEngine)
    }

    private fun snapshot(): Map<String, Any> {
        val s = GatewayState.state.value
        return mapOf(
            "status" to s.status.name,
            "detail" to s.detail,
            "sent" to s.sentToday,
            "failed" to s.failedToday,
            "received" to s.receivedToday,
            "pending" to PendingQueue.size(this),
            "log" to s.log,
            "enabled" to prefs.enabled,
            "paired" to prefs.isPaired,
            "serverUrl" to prefs.serverUrl,
            "deviceName" to prefs.deviceName,
        )
    }

    private fun isIgnoringBattery(): Boolean =
        (getSystemService(POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(packageName)

    @SuppressLint("BatteryLife")
    private fun requestBatteryExemption() {
        runCatching {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        }.onFailure {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }
}
