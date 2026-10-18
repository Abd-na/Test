package com.veta.smsgateway

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

data class SmsJob(val id: String, val to: String, val text: String, val sim: Int?)

class ApiException(val code: Int, message: String) : IOException(message)

/** Talks to the Veta Messenger device API (/api/device/v1). */
class ApiClient(private val baseUrl: String, private val token: String) {

    private val json = "application/json; charset=utf-8".toMediaType()

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(70, TimeUnit.SECONDS) // long-poll waits up to ~25s server side
        .writeTimeout(20, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private fun url(path: String) = "$baseUrl/api/device/v1$path"

    private fun call(request: Request.Builder): JSONObject {
        val req = request.header("Authorization", "Bearer $token")
            .header("Accept", "application/json")
            .header("User-Agent", "VetaSmsGateway/${BuildConfig.VERSION_NAME}")
            .build()
        client.newCall(req).execute().use { res ->
            val body = res.body?.string().orEmpty()
            if (!res.isSuccessful) {
                val msg = runCatching { JSONObject(body).getJSONObject("error").getString("message") }
                    .getOrDefault("HTTP ${res.code}")
                throw ApiException(res.code, msg)
            }
            return if (body.isBlank()) JSONObject() else JSONObject(body)
        }
    }

    private fun post(path: String, payload: JSONObject) =
        call(Request.Builder().url(url(path)).post(payload.toString().toRequestBody(json)))

    fun heartbeat(info: JSONObject): JSONObject = post("/heartbeat", info).optJSONObject("data") ?: JSONObject()

    fun pollOutbox(waitSec: Int, limit: Int): List<SmsJob> {
        val res = call(Request.Builder().url(url("/outbox?wait=$waitSec&limit=$limit")).get())
        val data = res.optJSONArray("data") ?: JSONArray()
        return (0 until data.length()).map { i ->
            val o = data.getJSONObject(i)
            SmsJob(
                id = o.getString("id"),
                to = o.getString("to"),
                text = o.optString("text", ""),
                sim = if (o.isNull("sim")) null else o.optInt("sim"),
            )
        }
    }

    fun reportStatus(id: String, status: String, error: String? = null) {
        val payload = JSONObject().put("id", id).put("status", status)
        if (error != null) payload.put("error", error)
        post("/status", payload)
    }

    fun pushInbox(messages: JSONArray) {
        post("/inbox", JSONObject().put("messages", messages))
    }
}
