package com.veta.smsgateway

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Live state shown in the UI (service status + a short activity log). */
object GatewayState {
    enum class Status { STOPPED, CONNECTING, ONLINE, ERROR }

    data class Snapshot(
        val status: Status = Status.STOPPED,
        val detail: String = "",
        val sentToday: Int = 0,
        val failedToday: Int = 0,
        val receivedToday: Int = 0,
        val log: List<String> = emptyList(),
        val version: Long = 0,
    )

    private val _state = MutableStateFlow(Snapshot())
    val state: StateFlow<Snapshot> = _state.asStateFlow()

    private val time = SimpleDateFormat("HH:mm:ss", Locale.US)

    fun status(status: Status, detail: String = "") = _state.update { it.copy(status = status, detail = detail) }

    fun log(line: String) = _state.update {
        it.copy(log = (listOf("${time.format(Date())}  $line") + it.log).take(100))
    }

    /** Forces a new snapshot (e.g. after pairing changed) so the UI refreshes. */
    fun touch() = _state.update { it.copy(version = it.version + 1) }

    fun countSent() = _state.update { it.copy(sentToday = it.sentToday + 1) }
    fun countFailed() = _state.update { it.copy(failedToday = it.failedToday + 1) }
    fun countReceived() = _state.update { it.copy(receivedToday = it.receivedToday + 1) }
}
