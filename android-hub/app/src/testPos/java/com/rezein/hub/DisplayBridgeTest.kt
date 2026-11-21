package com.rezein.hub

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DisplayBridgeTest {
    @Test fun stateIsPassedAsAQuotedString() {
        val s = DisplayBridge.pushScript("{\"mode\":\"sale\",\"name\":\"a\\\"); alert(1); (\\\"\"}")
        assertTrue(s.startsWith("window.setDisplay && window.setDisplay(\""))
        // Take out every escaped backslash and escaped quote: only the two quotes that open and close the string may remain.
        val bare = s.replace("\\\\", "").replace("\\\"", "")
        assertEquals(2, bare.count { it == '"' })
    }

    @Test fun scanScriptQuotesTheCode() {
        assertEquals("window.dispatchEvent(new CustomEvent('rezein-scan', { detail: { code: \"8801234\" } }));", DisplayBridge.scanScript("8801234"))
    }

    @Test fun onlyJsonObjectsAreKept() {
        assertTrue(DisplayBridge.isState("{\"mode\":\"idle\"}"))
        assertFalse(DisplayBridge.isState("not json"))
    }

    @Test fun knowsTheSunmiScanner() {
        assertEquals("data", DisplayBridge.SCAN_ACTIONS["com.sunmi.scanner.ACTION_DATA_CODE_RECEIVED"])
    }
}
