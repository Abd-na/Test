package com.veta.smsgateway

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.LayoutInflater
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.textfield.TextInputEditText
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.veta.smsgateway.databinding.ActivityMainBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var prefs: Prefs

    private val requiredPermissions: Array<String>
        get() = buildList {
            add(Manifest.permission.SEND_SMS)
            add(Manifest.permission.RECEIVE_SMS)
            add(Manifest.permission.READ_PHONE_STATE)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.POST_NOTIFICATIONS)
        }.toTypedArray()

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { refreshSetup() }

    private val scanLauncher = registerForActivityResult(ScanContract()) { result ->
        val contents = result.contents ?: return@registerForActivityResult
        try {
            val json = JSONObject(contents)
            pair(json.getString("url"), json.getString("token"), json.optString("name"))
        } catch (e: Exception) {
            toast(getString(R.string.invalid_qr))
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        prefs = Prefs(this)

        binding.scanButton.setOnClickListener {
            scanLauncher.launch(
                ScanOptions()
                    .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                    .setPrompt(getString(R.string.scan_prompt))
                    .setBeepEnabled(false)
                    .setOrientationLocked(true)
            )
        }
        binding.manualButton.setOnClickListener { showManualDialog() }
        binding.unpairButton.setOnClickListener {
            GatewayService.stop(this)
            prefs.clearPairing()
            refreshPairing()
        }
        binding.permissionsButton.setOnClickListener { permissionLauncher.launch(requiredPermissions) }
        binding.batteryButton.setOnClickListener { requestBatteryExemption() }
        binding.enableSwitch.setOnCheckedChangeListener { button, checked ->
            if (!button.isPressed) return@setOnCheckedChangeListener
            if (checked) {
                if (!hasPermission(Manifest.permission.SEND_SMS)) {
                    button.isChecked = false
                    toast(getString(R.string.need_permissions))
                    permissionLauncher.launch(requiredPermissions)
                    return@setOnCheckedChangeListener
                }
                if (!prefs.isPaired) {
                    button.isChecked = false
                    toast(getString(R.string.not_paired))
                    return@setOnCheckedChangeListener
                }
                prefs.enabled = true
                GatewayService.start(this)
            } else {
                prefs.enabled = false
                GatewayService.stop(this)
            }
        }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                GatewayState.state.collect { render(it) }
            }
        }

        if (prefs.enabled && prefs.isPaired) GatewayService.start(this)
    }

    override fun onResume() {
        super.onResume()
        refreshPairing()
        refreshSetup()
    }

    private fun render(s: GatewayState.Snapshot) {
        val (label, color) = when (s.status) {
            GatewayState.Status.ONLINE -> R.string.status_online to R.color.status_online
            GatewayState.Status.CONNECTING -> R.string.status_connecting to R.color.status_connecting
            GatewayState.Status.ERROR -> R.string.status_error to R.color.status_error
            GatewayState.Status.STOPPED -> R.string.status_stopped to R.color.status_stopped
        }
        binding.statusText.setText(label)
        binding.statusDot.backgroundTintList = ColorStateList.valueOf(ContextCompat.getColor(this, color))
        binding.statusDetail.text = s.detail
        binding.statsText.text = getString(R.string.stats, s.sentToday, s.failedToday, s.receivedToday, PendingQueue.size(this))
        binding.logText.text = s.log.joinToString("\n")
        binding.enableSwitch.isChecked = prefs.enabled
    }

    private fun refreshPairing() {
        val paired = prefs.isPaired
        binding.pairingInfo.text = if (paired) {
            getString(R.string.paired_with, prefs.serverUrl, prefs.deviceName.ifBlank { "—" })
        } else {
            getString(R.string.not_paired)
        }
        binding.unpairButton.isEnabled = paired
        binding.enableSwitch.isEnabled = paired
        binding.enableSwitch.isChecked = prefs.enabled
    }

    private fun refreshSetup() {
        val missing = requiredPermissions.filterNot { hasPermission(it) }.map { it.substringAfterLast('.') }
        binding.permissionsInfo.text = buildString {
            append(if (missing.isEmpty()) getString(R.string.permissions_ok) else getString(R.string.permissions_missing, missing.joinToString()))
            append('\n')
            append(if (isIgnoringBattery()) getString(R.string.battery_ok) else getString(R.string.battery_missing))
        }
        binding.permissionsButton.isEnabled = missing.isNotEmpty()
        binding.batteryButton.isEnabled = !isIgnoringBattery()
    }

    private fun hasPermission(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

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

    private fun showManualDialog() {
        val view = LayoutInflater.from(this).inflate(R.layout.dialog_manual, null)
        val url = view.findViewById<TextInputEditText>(R.id.urlInput)
        val token = view.findViewById<TextInputEditText>(R.id.tokenInput)
        url.setText(prefs.serverUrl)
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.manual_pair)
            .setView(view)
            .setPositiveButton(R.string.save) { _, _ -> pair(url.text.toString(), token.text.toString(), null) }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    /** Validates the URL + token against the server, then saves them. */
    private fun pair(rawUrl: String, token: String, name: String?) {
        val url = rawUrl.trim().trimEnd('/')
        if (!url.startsWith("http") || !token.startsWith("vmd_")) {
            toast(getString(R.string.invalid_qr))
            return
        }
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching { ApiClient(url, token).heartbeat(DeviceInfo.collect(this@MainActivity)) }
            }
            result.onSuccess { data ->
                prefs.serverUrl = url
                prefs.token = token
                prefs.deviceName = data.optJSONObject("device")?.optString("name") ?: name.orEmpty()
                toast(getString(R.string.pair_ok))
                refreshPairing()
                if (hasPermission(Manifest.permission.SEND_SMS)) {
                    prefs.enabled = true
                    GatewayService.stop(this@MainActivity)
                    GatewayService.start(this@MainActivity)
                    refreshPairing()
                } else {
                    permissionLauncher.launch(requiredPermissions)
                }
            }.onFailure { toast(getString(R.string.pair_failed, it.message ?: "")) }
        }
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
}
