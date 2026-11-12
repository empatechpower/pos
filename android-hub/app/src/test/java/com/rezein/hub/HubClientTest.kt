package com.rezein.hub

import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread


/** A tiny HTTP server for the tests (the Java one is not on Android's classpath). */
class MiniHttp(private val handler: (path: String, body: String) -> Pair<Int, String>) {
    private val ss = ServerSocket(0, 20, java.net.InetAddress.getByName("127.0.0.1"))
    val port: Int get() = ss.localPort
    init {
        thread(isDaemon = true) {
            try {
                while (true) {
                    val sock = ss.accept()
                    thread(isDaemon = true) {
                        sock.use { s ->
                            val input = java.io.BufferedInputStream(s.getInputStream())
                            fun line(): String { val sb = StringBuilder(); while (true) { val c = input.read(); if (c < 0 || c == '\n'.code) break; if (c != '\r'.code) sb.append(c.toChar()) }; return sb.toString() }
                            val request = line()
                            if (request.isEmpty()) return@use
                            var length = 0
                            while (true) { val h = line(); if (h.isEmpty()) break; if (h.lowercase().startsWith("content-length:")) length = h.substringAfter(":").trim().toInt() }
                            val body = String(input.readNBytes(length), Charsets.UTF_8)
                            val (status, reply) = handler(request.split(" ")[1], body)
                            val bytes = reply.toByteArray()
                            s.getOutputStream().write("HTTP/1.1 $status X\r\ncontent-type: application/json\r\ncontent-length: ${bytes.size}\r\nconnection: close\r\n\r\n".toByteArray() + bytes)
                            s.getOutputStream().flush()
                        }
                    }
                }
            } catch (_: Exception) {}
        }
    }
    fun stop() { try { ss.close() } catch (_: Exception) {} }
}

/** The hub logic against a pretend shop server and pretend printers, all on this computer. */
class HubClientTest {
    private lateinit var server: MiniHttp
    private lateinit var base: String
    private val reports = CopyOnWriteArrayList<Triple<String, String, String>>() // job id, outcome, body
    private val texts = java.util.concurrent.CopyOnWriteArrayList<String>()
    private val pending = CopyOnWriteArrayList<JSONObject>()
    private var claimStatus = 200
    private var enrollStatus = 200
    private val printers = mutableListOf<ServerSocket>()

    @Before fun start() {
        server = MiniHttp { path, body ->
            when {
                path == "/api/print/claim" -> if (claimStatus != 200) Pair(claimStatus, "{}") else {
                    val jobs = JSONArray(); pending.forEach { jobs.put(it) }; pending.clear()
                    Pair(200, JSONObject().put("jobs", jobs).toString())
                }
                path.startsWith("/api/print/jobs/") -> {
                    val parts = path.split("/")
                    reports.add(Triple(parts[4], parts[5], body))
                    Pair(200, "{}")
                }
                path == "/api/print/sms/number" -> { texts.add("number:" + body); Pair(200, "{}") }
                path == "/api/print/sms" -> { texts.add(body); Pair(200, "{\"matched\":true}") }
                path == "/api/devices/enroll" -> {
                    val code = JSONObject(body).getString("code")
                    if (enrollStatus != 200) Pair(enrollStatus, "{}") else if (code == "GOOD") Pair(200, JSONObject().put("token", "tok123").put("deviceId", "d1").toString()) else Pair(401, "{}")
                }
                else -> Pair(404, "{}")
            }
        }
        base = "http://127.0.0.1:${server.port}"
    }

    @After fun stop() {
        server.stop()
        printers.forEach { try { it.close() } catch (_: Exception) {} }
    }

    /** A pretend printer: a port that remembers what it was sent. */
    private fun printer(): Pair<Int, () -> String> {
        val ss = ServerSocket(0, 5, java.net.InetAddress.getByName("127.0.0.1")); printers.add(ss)
        val got = StringBuilder()
        thread(isDaemon = true) { try { while (true) { ss.accept().use { s -> got.append(String(s.getInputStream().readBytes(), Charsets.ISO_8859_1)) } } } catch (_: Exception) {} }
        return Pair(ss.localPort) { got.toString() }
    }

    private fun job(id: String, printerId: String, port: Int, text: String) = JSONObject()
        .put("id", id).put("docType", "kitchen").put("attempt", 1)
        .put("printer", JSONObject().put("id", printerId).put("name", printerId).put("host", "127.0.0.1").put("port", port))
        .put("payloadBase64", Base64.getEncoder().encodeToString(text.toByteArray()))

    private fun client(sender: Sender = SocketSender()) = HubClient(base, "tok", sender, retryPauseMs = 5)

    @Test fun printsAJobAndTellsTheServerItWasDone() {
        val (port, got) = printer()
        pending.add(job("j1", "kitchen", port, "KITCHEN TICKET 42"))
        val r = client().runOnce()
        assertEquals(RunResult(1, 0), r)
        Thread.sleep(200)
        assertTrue(got().contains("KITCHEN TICKET 42"))
        assertEquals(listOf(Triple("j1", "done", "")), reports.toList())
        assertEquals(RunResult(0, 0), client().runOnce()) // nothing left, nothing printed twice
    }

    @Test fun sendsEachPrintersJobsToThatPrinter() {
        val (p1, got1) = printer(); val (p2, got2) = printer()
        pending.add(job("a", "front", p1, "FRONT")); pending.add(job("b", "bar", p2, "BAR"))
        assertEquals(RunResult(2, 0), client().runOnce())
        Thread.sleep(200)
        assertTrue(got1().contains("FRONT") && !got1().contains("BAR"))
        assertTrue(got2().contains("BAR") && !got2().contains("FRONT"))
    }

    @Test fun aPrinterThatIsOffFailsTheJobSoTheServerKeepsAndRetriesIt() {
        val dead = ServerSocket(0).use { it.localPort } // nothing listens here any more
        pending.add(job("j1", "kitchen", dead, "x")); pending.add(job("j2", "kitchen", dead, "y"))
        val r = client().runOnce()
        assertEquals(RunResult(0, 2), r)
        val first = reports.first { it.first == "j1" }
        assertEquals("failed", first.second)
        assertFalse(JSONObject(first.third).has("ambiguous")) // never reached the printer: safe to retry
        assertEquals("failed", reports.first { it.first == "j2" }.second) // later jobs wait their turn too
    }

    @Test fun whenItIsUnsureTheJobReachedThePrinterItSaysSo() {
        pending.add(job("j1", "kitchen", 9100, "x"))
        client { _, _, _ -> throw AmbiguousDelivery("connection broke while printing") }.runOnce()
        val body = JSONObject(reports.first { it.first == "j1" }.third)
        assertTrue(body.getBoolean("ambiguous"))
    }

    @Test fun tellsTheShopWhichNumberCustomersShouldText() {
        assertTrue(client().setSmsNumber("+65 8799 6394"))
        assertEquals("+65 8799 6394", JSONObject(texts.single().removePrefix("number:")).getString("number"))
    }

    @Test fun passesAReceivedTextToTheShopWithItsSenderAndCode() {
        assertTrue(client().forwardSms("+6591112222", "482913"))
        val sent = JSONObject(texts.single())
        assertEquals("+6591112222", sent.getString("from"))
        assertEquals("482913", sent.getString("body"))
    }

    @Test(expected = NotLinked::class) fun saysSoWhenTheShopNoLongerKnowsThisDevice() {
        claimStatus = 401
        client().runOnce()
    }

    @Test fun linksWithAGoodCodeAndExplainsABadOne() {
        val ok = Enroll.link(base, "GOOD", "Kitchen tablet")
        assertTrue(ok is Enroll.Result.Linked)
        assertEquals("tok123", (ok as Enroll.Result.Linked).token)
        val bad = Enroll.link(base, "WRONG", "Kitchen tablet")
        assertTrue((bad as Enroll.Result.Failed).why.contains("wrong, already used, or expired"))
        val unreachable = Enroll.link("http://127.0.0.1:1", "GOOD", "x")
        assertTrue((unreachable as Enroll.Result.Failed).why.startsWith("Could not reach"))
    }

    @Test fun addsHttpsToABareAddress() {
        assertEquals("https://pos-itlp.onrender.com", Enroll.normalise(" pos-itlp.onrender.com/ "))
        assertEquals("http://10.0.0.5:8787", Enroll.normalise("http://10.0.0.5:8787"))
    }

    @Test fun theTestPageIsRealEscPos() {
        val b = testPage()
        assertEquals(listOf<Byte>(0x1b, 0x40), b.take(2))
        assertTrue(String(b, Charsets.ISO_8859_1).contains("If you can read this, printing works."))
        assertEquals(listOf<Byte>(0x1d, 0x56, 0x42, 0x00), b.takeLast(4))
    }

    @Test fun theRealSocketSenderWritesTheExactBytes() {
        val (port, got) = printer()
        SocketSender().send("127.0.0.1", port, byteArrayOf(0x1b, 0x40, 0x41, 0x0a))
        Thread.sleep(200)
        assertEquals("\u001b@A\n", got())
    }
}
