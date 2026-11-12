package com.rezein.hub

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

/** One screen: link this tablet to the shop once, then see whether the hub is running and what it printed. */
class MainActivity : Activity() {
    private lateinit var config: Config
    private val ui = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            refresh()
            ui.postDelayed(this, 1000)
        }
    }

    private lateinit var setupGroup: LinearLayout
    private lateinit var statusGroup: LinearLayout
    private lateinit var address: EditText
    private lateinit var code: EditText
    private lateinit var deviceName: EditText
    private lateinit var linkMessage: TextView
    private lateinit var linkButton: Button
    private lateinit var status: TextView
    private lateinit var detail: TextView
    private lateinit var toggle: Button
    private lateinit var battery: Button
    private lateinit var printerIp: EditText
    private lateinit var log: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        config = Config(this)
        buildScreen()
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        if (config.isLinked && config.wantRunning && !HubState.running) HubService.start(this)
    }

    override fun onResume() {
        super.onResume()
        ui.post(tick)
    }

    override fun onPause() {
        ui.removeCallbacks(tick)
        super.onPause()
    }

    private fun dp(n: Int) = (n * resources.displayMetrics.density).toInt()
    private fun text(s: String, size: Float = 16f, bold: Boolean = false) = TextView(this).apply {
        text = s; textSize = size; if (bold) setTypeface(typeface, Typeface.BOLD); setPadding(0, dp(6), 0, dp(6))
    }
    private fun field(hint: String, type: Int = InputType.TYPE_CLASS_TEXT) = EditText(this).apply {
        this.hint = hint; inputType = type; setSingleLine(true)
    }
    private fun button(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label; isAllCaps = false; setOnClickListener { onClick() }
    }

    private fun buildScreen() {
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(20), dp(20), dp(20)) }
        root.addView(text("Rezein print hub", 24f, true))

        // ---- link this tablet to the shop (once)
        setupGroup = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        setupGroup.addView(text("Link this tablet to the shop. Ask a manager for the shop address and a one-time enrollment code (it lasts 15 minutes)."))
        address = field("Shop address, e.g. pos-itlp.onrender.com", InputType.TYPE_TEXT_VARIATION_URI)
        code = field("Enrollment code", InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS)
        deviceName = field("Name for this tablet").apply { setText("Kitchen tablet") }
        linkMessage = text("")
        linkButton = button("Link this tablet") { link() }
        listOf(address, code, deviceName, linkButton, linkMessage).forEach { setupGroup.addView(it) }
        root.addView(setupGroup)

        // ---- running status
        statusGroup = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        status = text("", 20f, true)
        detail = text("")
        toggle = button("Stop") { toggleRunning() }
        battery = button("Keep it running in the background") { allowBackground() }
        printerIp = field("Printer address, e.g. 192.168.1.50", InputType.TYPE_CLASS_TEXT)
        val testButton = button("Print a test page") { testPrint() }
        log = text("", 12f).apply { typeface = Typeface.MONOSPACE }
        val unlink = button("Unlink this tablet") { unlink() }
        listOf(status, detail, toggle, battery, text("Check a printer is reachable from this tablet:"), printerIp, testButton, text("Recent activity", 14f, true), log, unlink).forEach { statusGroup.addView(it) }
        root.addView(statusGroup)

        setContentView(ScrollView(this).apply { addView(root) })
    }

    private fun refresh() {
        val linked = config.isLinked
        setupGroup.visibility = if (linked) View.GONE else View.VISIBLE
        statusGroup.visibility = if (linked) View.VISIBLE else View.GONE
        if (!linked) return
        status.text = HubState.summary()
        status.setTextColor(when { !HubState.running -> 0xFF777777.toInt(); HubState.online == true -> 0xFF1B7F3B.toInt(); HubState.online == false -> 0xFFC0392B.toInt(); else -> 0xFF777777.toInt() })
        val last = if (HubState.lastPrintedAt > 0) java.text.SimpleDateFormat("HH:mm:ss").format(java.util.Date(HubState.lastPrintedAt)) else "nothing yet"
        detail.text = "${config.name} at ${config.baseUrl}\nPrinted: ${HubState.printed}   Failed: ${HubState.failed}   Last print: $last" + (HubState.lastProblem?.let { "\nProblem: $it" } ?: "")
        toggle.text = if (HubState.running) "Stop" else "Start"
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        val allowed = pm.isIgnoringBatteryOptimizations(packageName)
        battery.visibility = if (allowed) View.GONE else View.VISIBLE
        log.text = HubState.recent().joinToString("\n")
    }

    private fun link() {
        val a = address.text.toString().trim()
        val c = code.text.toString().trim()
        if (a.isEmpty() || c.isEmpty()) { linkMessage.text = "Enter the shop address and the code."; return }
        linkButton.isEnabled = false
        linkMessage.text = "Linking..."
        Thread {
            val name = deviceName.text.toString().trim().ifEmpty { "Print hub" }
            val result = Enroll.link(a, c, name)
            runOnUiThread {
                linkButton.isEnabled = true
                when (result) {
                    is Enroll.Result.Linked -> {
                        config.link(Enroll.normalise(a), result.token, name)
                        linkMessage.text = ""
                        HubService.start(this)
                        refresh()
                    }
                    is Enroll.Result.Failed -> linkMessage.text = result.why
                }
            }
        }.start()
    }

    private fun toggleRunning() {
        if (HubState.running) HubService.stop(this) else HubService.start(this)
        ui.postDelayed({ refresh() }, 300)
    }

    private fun allowBackground() {
        try {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        } catch (e: Exception) {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }

    private fun testPrint() {
        val ip = printerIp.text.toString().trim()
        if (ip.isEmpty()) { Toast.makeText(this, "Enter the printer's address first.", Toast.LENGTH_SHORT).show(); return }
        Thread {
            val message = try {
                SocketSender().send(ip, 9100, testPage())
                "Sent a test page to $ip. Paper should come out and cut."
            } catch (e: Exception) {
                "Could not print to $ip: ${e.message}. Check the printer is on and on the same network as this tablet."
            }
            HubState.log(message)
            runOnUiThread { Toast.makeText(this, message, Toast.LENGTH_LONG).show() }
        }.start()
    }

    private fun unlink() {
        HubService.stop(this)
        config.unlink()
        HubState.printed = 0
        HubState.failed = 0
        HubState.online = null
        refresh()
    }
}
