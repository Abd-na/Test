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
        /** Status of each paired line (SIM), keyed like [Pairing.line]. */
        val lines: Map<String, LineState> = emptyMap(),
    )

    data class LineState(val status: Status, val detail: String = "")

    private val _state = MutableStateFlow(Snapshot())
    val state: StateFlow<Snapshot> = _state.asStateFlow()

    private val time = SimpleDateFormat("HH:mm:ss", Locale.US)

    /** Whole-service status (stopped, not paired…); clears the per-line states. */
    fun status(status: Status, detail: String = "") =
        _state.update { it.copy(status = status, detail = detail, lines = emptyMap()) }

    /** Status of one line; the overall status is the best of all lines. */
    fun lineStatus(line: String, status: Status, detail: String = "") = _state.update {
        val lines = it.lines + (line to LineState(status, detail))
        val overall = listOf(Status.ONLINE, Status.CONNECTING, Status.ERROR)
            .firstOrNull { s -> lines.values.any { l -> l.status == s } } ?: Status.STOPPED
        val details = if (lines.size == 1) lines.values.first().detail
        else lines.filterValues { l -> l.status != Status.ONLINE && l.detail.isNotBlank() }
            .map { (k, l) -> "${Lines.label(k).ifEmpty { "*" }}: ${l.detail}" }.joinToString("\n")
        it.copy(status = overall, detail = details, lines = lines)
    }

    fun log(line: String) = _state.update {
        it.copy(log = (listOf("${time.format(Date())}  $line") + it.log).take(100))
    }

    /** Forces a new snapshot (e.g. after pairing changed) so the UI refreshes. */
    fun touch() = _state.update { it.copy(version = it.version + 1) }

    fun countSent() = _state.update { it.copy(sentToday = it.sentToday + 1) }
    fun countFailed() = _state.update { it.copy(failedToday = it.failedToday + 1) }
    fun countReceived() = _state.update { it.copy(receivedToday = it.receivedToday + 1) }
}
