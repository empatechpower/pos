package com.rezein.hub

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import java.util.Base64
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * The print hub's logic, with nothing Android in it so it can be tested on a normal computer.
 * It asks the shop's server for print jobs, writes each to its printer's network port (9100), and tells the server
 * how it went. The server keeps every job, so nothing is lost while this tablet, a printer or the internet is down.
 * Same protocol as hub.mjs.
 */

/** The connection was made and then broke, so the printer may already have the job. */
class AmbiguousDelivery(message: String) : Exception(message)

/** The server no longer knows this device (it was removed, or never linked). */
class NotLinked : Exception("this hub is not linked (or was removed). Link it again.")

class Job(val id: String, val docType: String, val printerId: String, val printerName: String, val host: String, val port: Int, val payload: ByteArray)

data class RunResult(val delivered: Int, val failed: Int)

fun interface Sender {
    fun send(host: String, port: Int, bytes: ByteArray)
}

/** Writes bytes to a printer's raw port. A failure before the connection is made is safe to retry; after it, it is ambiguous. */
class SocketSender : Sender {
    override fun send(host: String, port: Int, bytes: ByteArray) {
        val socket = Socket()
        try {
            socket.connect(InetSocketAddress(host, port), 5000)
        } catch (e: Exception) {
            socket.close()
            throw Exception("could not reach $host:$port (${e.message ?: e.javaClass.simpleName})")
        }
        try {
            socket.soTimeout = 5000
            val out = socket.getOutputStream()
            out.write(bytes)
            out.flush()
            socket.shutdownOutput()
        } catch (e: Exception) {
            throw AmbiguousDelivery("connection to $host:$port broke while printing (${e.message ?: e.javaClass.simpleName})")
        } finally {
            socket.close()
        }
    }
}

/** A short receipt that proves the printer, the network and the hub all work: initialise, text, feed, cut. */
fun testPage(): ByteArray {
    val out = ByteArrayOutputStream()
    out.write(byteArrayOf(0x1b, 0x40))
    out.write("Rezein\nTest page ${java.text.SimpleDateFormat("dd/MM/yyyy HH:mm").format(java.util.Date())}\nIf you can read this, printing works.\n\n\n\n".toByteArray(Charsets.US_ASCII))
    out.write(byteArrayOf(0x1d, 0x56, 0x42, 0x00))
    return out.toByteArray()
}

class Http(private val baseUrl: String) {
    class Reply(val status: Int, val body: String)

    fun post(path: String, token: String?, json: JSONObject?): Reply = send("POST", path, token, json)

    fun send(method: String, path: String, token: String?, json: JSONObject?): Reply {
        val conn = URL(baseUrl + path).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = 10_000
            conn.readTimeout = 20_000
            if (token != null) conn.setRequestProperty("x-device-token", token)
            if (json != null) {
                conn.setRequestProperty("content-type", "application/json")
                conn.doOutput = true
                conn.outputStream.use { it.write(json.toString().toByteArray(Charsets.UTF_8)) }
            }
            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            return Reply(status, stream?.use { String(it.readBytes(), Charsets.UTF_8) } ?: "")
        } finally {
            conn.disconnect()
        }
    }
}

class HubClient(
    baseUrl: String,
    private val token: String,
    private val sender: Sender = SocketSender(),
    private val log: (String) -> Unit = {},
    private val retryPauseMs: Long = 300,
) {
    private val http = Http(baseUrl.trimEnd('/'))

    fun claim(): List<Job> {
        val r = http.post("/api/print/claim", token, JSONObject().put("limit", 25))
        if (r.status == 401) throw NotLinked()
        if (r.status !in 200..299) throw Exception("the server answered ${r.status}")
        val arr: JSONArray = JSONObject(r.body).getJSONArray("jobs")
        return (0 until arr.length()).map {
            val j = arr.getJSONObject(it)
            val p = j.getJSONObject("printer")
            Job(j.getString("id"), j.optString("docType", "ticket"), p.getString("id"), p.optString("name", p.getString("id")), p.getString("host"), p.getInt("port"), Base64.getDecoder().decode(j.getString("payloadBase64")))
        }
    }

    /** Tell the shop which number customers should text to sign in: the number of the SIM in this tablet. Empty clears it. */
    fun setSmsNumber(number: String): Boolean {
        val r = http.send("PUT", "/api/print/sms/number", token, JSONObject().put("number", number))
        if (r.status == 401) throw NotLinked()
        return r.status in 200..299
    }

    /** Pass on a text this tablet received. The shop checks whether it is a customer's sign-in code. Returns true when it was accepted. */
    fun forwardSms(from: String, body: String): Boolean {
        val r = http.post("/api/print/sms", token, JSONObject().put("from", from).put("body", body))
        if (r.status == 401) throw NotLinked()
        return r.status in 200..299
    }

    /** Tell the server how a job went. A lost report leaves the job leased; the server then parks it as unconfirmed. */
    fun report(jobId: String, outcome: String, error: String? = null, ambiguous: Boolean = false): Boolean {
        val body = if (outcome == "failed") JSONObject().put("error", error ?: "unknown error").also { if (ambiguous) it.put("ambiguous", true) } else null
        var last = ""
        for (attempt in 1..4) {
            try {
                val r = http.post("/api/print/jobs/$jobId/$outcome", token, body)
                if (r.status in 200..299) return true
                last = "HTTP ${r.status}"
                if (r.status == 404) return true // the server no longer has it leased: nothing to report
            } catch (e: Exception) {
                last = e.message ?: e.javaClass.simpleName
            }
            Thread.sleep(retryPauseMs * attempt)
        }
        log("!! could not tell the server job $jobId was $outcome ($last). It will show as \"print unconfirmed\" if it printed.")
        return false
    }

    /** One printer's jobs, in order. After a failure the rest of that printer's jobs wait for the server's retry. */
    private fun deliver(jobs: List<Job>): RunResult {
        var delivered = 0
        var failed = 0
        var broken = false
        for (job in jobs) {
            if (broken) {
                report(job.id, "failed", "an earlier job to this printer failed")
                failed++
                continue
            }
            try {
                sender.send(job.host, job.port, job.payload)
                report(job.id, "done")
                delivered++
                log("printed ${job.docType} on ${job.printerName}")
            } catch (e: Exception) {
                broken = true
                val msg = e.message ?: e.javaClass.simpleName
                report(job.id, "failed", msg, e is AmbiguousDelivery)
                failed++
                log("!! ${job.docType} for ${job.printerName} (${job.host}) failed: $msg")
            }
        }
        return RunResult(delivered, failed)
    }

    /** One pass: claim jobs, send them (different printers at the same time), report. */
    fun runOnce(): RunResult {
        val jobs = claim()
        if (jobs.isEmpty()) return RunResult(0, 0)
        val groups = jobs.groupBy { it.printerId }.values.toList()
        if (groups.size == 1) return deliver(groups[0])
        val pool = Executors.newFixedThreadPool(groups.size)
        try {
            val results = groups.map { g -> pool.submit<RunResult> { deliver(g) } }.map { it.get() }
            return RunResult(results.sumOf { it.delivered }, results.sumOf { it.failed })
        } finally {
            pool.shutdown()
            pool.awaitTermination(1, TimeUnit.SECONDS)
        }
    }
}

object Enroll {
    sealed class Result {
        class Linked(val token: String, val deviceId: String) : Result()
        class Failed(val why: String) : Result()
    }

    /** Trade a one-time code for this device's token. */
    fun link(address: String, code: String, name: String): Result {
        val base = normalise(address)
        return try {
            val r = Http(base).post("/api/devices/enroll", null, JSONObject().put("code", code.trim()).put("name", name))
            when {
                r.status in 200..299 -> JSONObject(r.body).let { Result.Linked(it.getString("token"), it.optString("deviceId")) }
                r.status == 401 -> Result.Failed("The code is wrong, already used, or expired. Codes last 15 minutes: ask for a new one.")
                r.status == 429 -> Result.Failed("Too many tries. Wait a few minutes.")
                else -> Result.Failed("The shop answered ${r.status}.")
            }
        } catch (e: Exception) {
            Result.Failed("Could not reach $base (${e.message ?: e.javaClass.simpleName}).")
        }
    }

    fun normalise(address: String): String {
        val a = address.trim().trimEnd('/')
        return if (a.startsWith("http://") || a.startsWith("https://")) a else "https://$a"
    }
}
