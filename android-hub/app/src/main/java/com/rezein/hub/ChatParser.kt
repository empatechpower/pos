package com.rezein.hub

/** What a messaging app's notification gives us: who sent it (the conversation title) and what it said. */
object ChatParser {
    private val code = Regex("(?<!\\d)\\d{6}(?!\\d)")
    private val phoneLike = Regex("^\\+?[\\d\\s().-]{7,20}$")

    /** The sender's number as shown (digits, with a leading + kept), or null when the title is a name, not a number. */
    fun senderNumber(title: String?): String? {
        val t = title?.trim() ?: return null
        if (!phoneLike.matches(t)) return null
        val digits = t.filter { it.isDigit() }
        if (digits.length < 7 || digits.length > 15) return null
        return if (t.startsWith("+")) "+$digits" else digits
    }

    /** The 6-digit code in a line of text, or null. */
    fun codeIn(text: String?): String? = text?.let { code.find(it)?.value }

    /** Everything worth forwarding from one notification: (sender number, code) pairs, with no repeats. */
    fun fromNotification(title: String?, lines: List<String?>, senders: List<String?> = emptyList()): List<Pair<String, String>> {
        val from = senderNumber(title)
        val out = LinkedHashSet<Pair<String, String>>()
        lines.forEachIndexed { i, line ->
            val c = codeIn(line) ?: return@forEachIndexed
            val who = from ?: senderNumber(senders.getOrNull(i)) ?: return@forEachIndexed
            out.add(who to c)
        }
        return out.toList()
    }
}
