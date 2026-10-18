package com.veta.smsgateway

import android.Manifest
import android.annotation.SuppressLint
import android.app.role.RoleManager
import android.content.Intent
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.provider.Telephony
import androidx.core.content.ContextCompat
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
import kotlinx.coroutines.withContext

/**
 * Hosts the Flutter UI and exposes the native gateway to it:
 *  - MethodChannel "veta/gateway": pair / unpair / start / stop / battery settings
 *  - EventChannel  "veta/gateway/events": live status snapshots
 *  - MethodChannel "veta/sms": the messaging app (conversations, send, default SMS role)
 *  - EventChannel  "veta/sms/events": fires whenever the phone's SMS store changes
 */
class MainActivity : FlutterActivity() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var eventsJob: Job? = null
    private val prefs by lazy { Prefs(this) }
    private var smsChannel: MethodChannel? = null
    private var smsObserver: ContentObserver? = null

    /** Conversation to open, from a notification or an sms:/smsto: link. */
    private var pendingOpen: Map<String, String>? = null

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
                "testSms" -> {
                    val to = call.argument<String>("to").orEmpty().trim()
                    if (to.isEmpty()) {
                        result.error("invalid", "phone number is required", null)
                        return@setMethodCallHandler
                    }
                    val job = SmsJob(
                        id = "${SmsSender.TEST_PREFIX}${System.currentTimeMillis()}",
                        to = to,
                        text = call.argument<String>("text") ?: "Veta SMS Gateway ✓",
                        sim = call.argument<Int>("sim"),
                    )
                    try {
                        val route = SmsSender.send(this, job)
                        GatewayState.log("↑ رسالة تجريبية إلى $to عبر $route")
                        result.success(route)
                    } catch (e: Exception) {
                        GatewayState.log("✗ الرسالة التجريبية: ${e.message}")
                        result.error("send_failed", e.message, null)
                    }
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

        configureSms(messenger)
        pendingOpen = openRequestFrom(intent)

        if (prefs.enabled && prefs.isPaired) GatewayService.start(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        openRequestFrom(intent)?.let { req ->
            pendingOpen = null
            smsChannel?.invokeMethod("openConversation", req)
        }
    }

    /** address (+ optional draft body) from a notification tap or an sms:/smsto: intent. */
    private fun openRequestFrom(intent: Intent?): Map<String, String>? {
        intent ?: return null
        intent.getStringExtra(MessageNotifier.EXTRA_OPEN_ADDRESS)?.let { return mapOf("address" to it) }
        val data = intent.data ?: return null
        if (data.scheme !in setOf("sms", "smsto", "mms", "mmsto")) return null
        val address = Uri.decode(data.schemeSpecificPart.substringBefore('?')).replace(",", ";").substringBefore(';').trim()
        val body = intent.getStringExtra("sms_body") ?: intent.getStringExtra(Intent.EXTRA_TEXT)
            ?: data.schemeSpecificPart.substringAfter("body=", "").takeIf { it.isNotEmpty() }?.let(Uri::decode)
        return buildMap {
            put("address", address)
            if (!body.isNullOrEmpty()) put("body", body)
        }
    }

    private fun configureSms(messenger: io.flutter.plugin.common.BinaryMessenger) {
        val channel = MethodChannel(messenger, "veta/sms")
        smsChannel = channel
        channel.setMethodCallHandler { call, result ->
            if (call.method == "requestDefault") {
                requestDefaultSmsRole()
                result.success(null)
                return@setMethodCallHandler
            }
            // provider queries can be slow on big inboxes: run off the main thread
            scope.launch {
                try {
                    val value: Any? = withContext(Dispatchers.IO) {
                        when (call.method) {
                            "status" -> mapOf(
                                "isDefault" to SmsStore.isDefaultSmsApp(this@MainActivity),
                                "canRead" to granted(Manifest.permission.READ_SMS),
                                "canSend" to granted(Manifest.permission.SEND_SMS),
                                "canReadContacts" to granted(Manifest.permission.READ_CONTACTS),
                            )
                            "threads" -> SmsStore.threads(this@MainActivity)
                            "messages" -> {
                                val threadId = (call.argument<Number>("threadId"))?.toLong()
                                    ?: SmsStore.threadIdFor(this@MainActivity, call.argument<String>("address").orEmpty())
                                mapOf("threadId" to threadId, "messages" to SmsStore.messages(this@MainActivity, threadId))
                            }
                            "threadIdFor" -> SmsStore.threadIdFor(this@MainActivity, call.argument<String>("address").orEmpty())
                            "contactName" -> SmsStore.contactName(this@MainActivity, call.argument<String>("address").orEmpty())
                            "send" -> {
                                val to = call.argument<String>("to").orEmpty().trim()
                                val text = call.argument<String>("text").orEmpty()
                                require(to.isNotEmpty() && text.isNotEmpty()) { "number and text are required" }
                                SmsSender.send(
                                    this@MainActivity,
                                    SmsJob(id = "${SmsSender.UI_PREFIX}${System.nanoTime()}", to = to, text = text, sim = call.argument<Int>("sim")),
                                )
                            }
                            "markRead" -> {
                                val threadId = call.argument<Number>("threadId")!!.toLong()
                                SmsStore.markThreadRead(this@MainActivity, threadId)
                                MessageNotifier.cancel(this@MainActivity, threadId)
                                null
                            }
                            "deleteThread" -> SmsStore.deleteThread(this@MainActivity, call.argument<Number>("threadId")!!.toLong())
                            "deleteMessage" -> SmsStore.deleteMessage(this@MainActivity, call.argument<Number>("id")!!.toLong())
                            "consumeOpenRequest" -> pendingOpen.also { pendingOpen = null }
                            "clearNameCache" -> {
                                SmsStore.clearNameCache()
                                null
                            }
                            else -> throw UnsupportedOperationException(call.method)
                        }
                    }
                    result.success(value)
                } catch (e: UnsupportedOperationException) {
                    result.notImplemented()
                } catch (e: Exception) {
                    result.error("sms_error", e.message, null)
                }
            }
        }

        EventChannel(messenger, "veta/sms/events").setStreamHandler(object : EventChannel.StreamHandler {
            override fun onListen(arguments: Any?, events: EventChannel.EventSink) {
                smsObserver?.let { contentResolver.unregisterContentObserver(it) }
                val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
                    override fun onChange(selfChange: Boolean) {
                        events.success("changed")
                    }
                }
                smsObserver = observer
                runCatching { contentResolver.registerContentObserver(Telephony.Sms.CONTENT_URI, true, observer) }
            }

            override fun onCancel(arguments: Any?) {
                smsObserver?.let { contentResolver.unregisterContentObserver(it) }
                smsObserver = null
            }
        })
    }

    private fun granted(permission: String) =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    /** Shows Android's "set as default SMS app" dialog. */
    private fun requestDefaultSmsRole() {
        if (SmsStore.isDefaultSmsApp(this)) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val roles = getSystemService(RoleManager::class.java)
            if (roles != null && roles.isRoleAvailable(RoleManager.ROLE_SMS)) {
                @Suppress("DEPRECATION")
                startActivityForResult(roles.createRequestRoleIntent(RoleManager.ROLE_SMS), REQUEST_DEFAULT_SMS)
                return
            }
        }
        @Suppress("DEPRECATION")
        startActivity(Intent(Telephony.Sms.Intents.ACTION_CHANGE_DEFAULT).putExtra(Telephony.Sms.Intents.EXTRA_PACKAGE_NAME, packageName))
    }

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        smsObserver?.let { contentResolver.unregisterContentObserver(it) }
        smsObserver = null
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
            "canSendSms" to SmsSender.hasSendPermission(this),
        )
    }

    private fun isIgnoringBattery(): Boolean =
        (getSystemService(POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(packageName)

    companion object {
        private const val REQUEST_DEFAULT_SMS = 4201
    }

    @SuppressLint("BatteryLife")
    private fun requestBatteryExemption() {
        runCatching {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        }.onFailure {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }
}
