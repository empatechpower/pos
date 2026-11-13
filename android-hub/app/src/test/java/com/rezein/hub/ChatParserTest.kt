package com.rezein.hub

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ChatParserTest {
    @Test fun readsANumberTitleAndKeepsAPlus() {
        assertEquals("82756862", ChatParser.senderNumber("8275 6862"))
        assertEquals("+6582756862", ChatParser.senderNumber("+65 8275 6862"))
        assertNull(ChatParser.senderNumber("Mei Lin"))
        assertNull(ChatParser.senderNumber("123"))
        assertNull(ChatParser.senderNumber(null))
    }

    @Test fun findsTheSixDigitCodeAnywhereInTheText() {
        assertEquals("138080", ChatParser.codeIn("138080"))
        assertEquals("138080", ChatParser.codeIn("my code is 138080 thanks"))
        assertNull(ChatParser.codeIn("1380801"))
        assertNull(ChatParser.codeIn("hello"))
    }

    @Test fun passesOnTheSenderAndCodeOnceEvenWhenTheNotificationRepeatsIt() {
        val r = ChatParser.fromNotification("8275 6862", listOf("138080", "138080", "see you"))
        assertEquals(listOf("82756862" to "138080"), r)
    }

    @Test fun usesTheMessageSenderWhenTheTitleIsAGroupOrNameAndIgnoresOtherChats() {
        assertEquals(listOf("+6591234567" to "482913"), ChatParser.fromNotification("Messages", listOf("482913"), listOf("+65 9123 4567")))
        assertEquals(emptyList<Pair<String, String>>(), ChatParser.fromNotification("Mei Lin", listOf("482913")))
        assertEquals(emptyList<Pair<String, String>>(), ChatParser.fromNotification("8275 6862", listOf("lunch at 12?")))
    }
}
