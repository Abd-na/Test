package com.veta.smsgateway

import android.content.Context

/**
 * A "line" is what the UI shows a pairing card for: each SIM on a dual-SIM
 * phone, or a single "any SIM" line on a phone with one SIM.
 */
object Lines {
    data class Line(val key: String, val sim: SimCard?, val pairing: Pairing?)

    fun list(context: Context, prefs: Prefs = Prefs(context)): List<Line> {
        val sims = DeviceInfo.sims(context)
        val pairings = prefs.pairings
        val keys = when {
            sims.size >= 2 -> sims.map { it.slot.toString() }
            pairings.isNotEmpty() && pairings.none { it.line == Prefs.ANY } -> emptyList() // already paired per SIM
            else -> listOf(Prefs.ANY)
        }
        // keep pairings whose SIM is gone (or an old "any" pairing) visible so they can be removed
        val all = keys + pairings.map { it.line }.filter { it !in keys }
        return all.map { key -> Line(key, sims.firstOrNull { it.slot.toString() == key }, pairings.firstOrNull { it.line == key }) }
    }

    /** Pairing that should get an SMS received on [sim] (null slot = vendor did not say). */
    fun forIncoming(prefs: Prefs, sim: Int?): Pairing? {
        val pairings = prefs.pairings
        return pairings.firstOrNull { sim != null && it.sim == sim }
            ?: pairings.firstOrNull { it.line == Prefs.ANY }
            ?: if (sim == null) pairings.firstOrNull() else null
    }

    /** "SIM2" for the log; empty when the phone has only the "any SIM" line. */
    fun label(line: String) = if (line == Prefs.ANY) "" else "SIM$line"
}
