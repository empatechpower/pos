package com.rezein.hub

import org.json.JSONObject

/**
 * The glue between the till (the POS web app) and the customer's screen, kept free of Android types so it can be tested.
 * The till calls RezeinNative.display(json); the second screen's page is given that same state through window.setDisplay.
 */
object DisplayBridge {
    /** The script that hands a state to the customer display page. The state travels as a quoted string, so nothing in it can run as code. */
    fun pushScript(stateJson: String): String = "window.setDisplay && window.setDisplay(${JSONObject.quote(stateJson)});"

    /** The script that tells the till a barcode was scanned. */
    fun scanScript(code: String): String = "window.dispatchEvent(new CustomEvent('rezein-scan', { detail: { code: ${JSONObject.quote(code)} } }));"

    /** A state worth keeping to replay when the screen's page (re)loads: anything that is a JSON object. */
    fun isState(stateJson: String): Boolean = try { JSONObject(stateJson); true } catch (_: Exception) { false }

    /** Scanner broadcasts we understand: action -> the extra holding the code. Sunmi's built-in scanner, and a generic one any other can be pointed at. */
    val SCAN_ACTIONS: Map<String, String> = mapOf(
        "com.sunmi.scanner.ACTION_DATA_CODE_RECEIVED" to "data",
        "com.rezein.SCAN" to "data",
    )
}
